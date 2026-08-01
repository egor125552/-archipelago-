import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import process from "node:process";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function integerArgument(name, fallback) {
  const value = Math.floor(Number(argument(name, fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function jsonFiles(root) {
  const entries = await readdir(root, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await jsonFiles(path));
    else if (entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

export function expectedBattlesForShard(totalBattles, shard, shards) {
  if (shard >= totalBattles) return 0;
  return Math.floor((totalBattles - 1 - shard) / shards) + 1;
}

export function mergeSelfPlayShards(reports, {expectedBattles, expectedShards, expectedStartIndex}) {
  const failures = [];
  const byShard = new Map();
  for (const report of reports) {
    const shard = Number(report?.shard);
    if (!Number.isInteger(shard) || shard < 0 || shard >= expectedShards) {
      failures.push(`invalid-shard-${String(report?.shard)}`);
      continue;
    }
    if (byShard.has(shard)) failures.push(`duplicate-shard-${shard}`);
    else byShard.set(shard, report);
  }

  const outcomeCounts = {};
  const eliteEpisodes = [];
  let completedBattles = 0;
  let minimumScore = Infinity;
  let maximumScore = -Infinity;
  for (let shard = 0; shard < expectedShards; shard += 1) {
    const report = byShard.get(shard);
    if (!report) {
      failures.push(`missing-shard-${shard}`);
      continue;
    }
    const expectedLocal = expectedBattlesForShard(expectedBattles, shard, expectedShards);
    const localCompleted = Number(report.completedBattles) || 0;
    if (Number(report.requestedBattles) !== expectedBattles) failures.push(`requested-count-mismatch-${shard}`);
    if (Number(report.startIndex) !== expectedStartIndex) failures.push(`start-index-mismatch-${shard}`);
    if (Number(report.endIndex) !== expectedStartIndex + expectedBattles) failures.push(`end-index-mismatch-${shard}`);
    if (Number(report.shards) !== expectedShards) failures.push(`shard-count-mismatch-${shard}`);
    if (localCompleted !== expectedLocal) failures.push(`completed-count-mismatch-${shard}-${localCompleted}-of-${expectedLocal}`);
    const localOutcomeTotal = Object.values(report.outcomeCounts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    if (localOutcomeTotal !== localCompleted) failures.push(`outcome-count-mismatch-${shard}`);
    completedBattles += localCompleted;
    for (const [name, value] of Object.entries(report.outcomeCounts || {})) {
      outcomeCounts[name] = (outcomeCounts[name] || 0) + (Number(value) || 0);
    }
    eliteEpisodes.push(...(report.eliteEpisodes || []));
    minimumScore = Math.min(minimumScore, Number(report.scoreRange?.minimum));
    maximumScore = Math.max(maximumScore, Number(report.scoreRange?.maximum));
  }
  if (completedBattles !== expectedBattles) failures.push(`aggregate-completed-${completedBattles}-of-${expectedBattles}`);

  const duplicateEliteIds = [];
  const seenEliteIds = new Set();
  for (const episode of eliteEpisodes) {
    const id = String(episode?.id || "");
    if (!id || seenEliteIds.has(id)) duplicateEliteIds.push(id || "missing-id");
    seenEliteIds.add(id);
  }
  if (duplicateEliteIds.length) failures.push(`duplicate-elite-ids-${duplicateEliteIds.length}`);

  return {
    format: "echo-neural-selfplay-aggregate-v1",
    generatedAt: new Date().toISOString(),
    expectedBattles,
    completedBattles,
    startIndex: expectedStartIndex,
    endIndex: expectedStartIndex + expectedBattles,
    expectedShards,
    receivedShards: byShard.size,
    outcomeCounts,
    scoreRange: {
      minimum: Number.isFinite(minimumScore) ? minimumScore : null,
      maximum: Number.isFinite(maximumScore) ? maximumScore : null,
    },
    eliteEpisodes,
    failures,
    verdict: failures.length ? "incomplete" : "complete",
    critique: [
      "Coverage proves the declared shard counts and index range, not that the scripted distribution represents human play.",
      "Only elite trajectories are retained in the aggregate; non-elite battle outcomes remain available as counts, not full trajectories.",
      "A complete batch is still only one campaign range and must not be reported as the full million-target campaign without contiguous range accounting.",
    ],
  };
}

async function main() {
  const input = argument("input", "training/reports/selfplay/input");
  const output = argument("output", "training/reports/selfplay-aggregate.json");
  const expectedBattles = Math.max(1, integerArgument("expected-battles", 256));
  const expectedShards = Math.max(1, integerArgument("expected-shards", 8));
  const expectedStartIndex = integerArgument("expected-start-index", 0);
  const files = await jsonFiles(input);
  const reports = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.format === "echo-neural-selfplay-elites-v1") reports.push(parsed);
  }
  const aggregate = mergeSelfPlayShards(reports, {expectedBattles, expectedShards, expectedStartIndex});
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify({output, verdict: aggregate.verdict, completedBattles: aggregate.completedBattles, failures: aggregate.failures}, null, 2));
  if (aggregate.verdict !== "complete") process.exitCode = 4;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
