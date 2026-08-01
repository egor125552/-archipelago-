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

function addCounts(target, source) {
  for (const [name, value] of Object.entries(source || {})) target[name] = (target[name] || 0) + (Number(value) || 0);
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

  const exploredOutcomeCounts = {};
  const baselineOutcomeCounts = {};
  const interventionCounts = {};
  const eliteEpisodes = [];
  let completedBattles = 0;
  let authoritativeRollouts = 0;
  let positiveAdvantagePairs = 0;
  let minimumScore = Infinity;
  let maximumScore = -Infinity;
  let minimumAdvantage = Infinity;
  let maximumAdvantage = -Infinity;
  let weightedAdvantage = 0;

  for (let shard = 0; shard < expectedShards; shard += 1) {
    const report = byShard.get(shard);
    if (!report) {
      failures.push(`missing-shard-${shard}`);
      continue;
    }
    const expectedLocal = expectedBattlesForShard(expectedBattles, shard, expectedShards);
    const localCompleted = Number(report.completedBattles) || 0;
    const localRollouts = Number(report.authoritativeRollouts) || 0;
    if (Number(report.requestedBattles) !== expectedBattles) failures.push(`requested-count-mismatch-${shard}`);
    if (Number(report.startIndex) !== expectedStartIndex) failures.push(`start-index-mismatch-${shard}`);
    if (Number(report.endIndex) !== expectedStartIndex + expectedBattles) failures.push(`end-index-mismatch-${shard}`);
    if (Number(report.shards) !== expectedShards) failures.push(`shard-count-mismatch-${shard}`);
    if (localCompleted !== expectedLocal) failures.push(`completed-count-mismatch-${shard}-${localCompleted}-of-${expectedLocal}`);
    if (localRollouts !== localCompleted * 2) failures.push(`paired-rollout-count-mismatch-${shard}-${localRollouts}-of-${localCompleted * 2}`);
    const exploredTotal = Object.values(report.exploredOutcomeCounts || report.outcomeCounts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const baselineTotal = Object.values(report.baselineOutcomeCounts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const interventionTotal = Object.values(report.interventionCounts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    if (exploredTotal !== localCompleted) failures.push(`explored-outcome-count-mismatch-${shard}`);
    if (baselineTotal !== localCompleted) failures.push(`baseline-outcome-count-mismatch-${shard}`);
    if (report.format === "echo-neural-selfplay-elites-v3" && interventionTotal !== localCompleted) failures.push(`intervention-count-mismatch-${shard}`);
    completedBattles += localCompleted;
    authoritativeRollouts += localRollouts;
    positiveAdvantagePairs += Number(report.positiveAdvantagePairs) || 0;
    addCounts(exploredOutcomeCounts, report.exploredOutcomeCounts || report.outcomeCounts);
    addCounts(baselineOutcomeCounts, report.baselineOutcomeCounts);
    addCounts(interventionCounts, report.interventionCounts);
    eliteEpisodes.push(...(report.eliteEpisodes || []));
    minimumScore = Math.min(minimumScore, Number(report.scoreRange?.minimum));
    maximumScore = Math.max(maximumScore, Number(report.scoreRange?.maximum));
    minimumAdvantage = Math.min(minimumAdvantage, Number(report.advantageRange?.minimum));
    maximumAdvantage = Math.max(maximumAdvantage, Number(report.advantageRange?.maximum));
    weightedAdvantage += (Number(report.advantageRange?.mean) || 0) * localCompleted;
  }
  if (completedBattles !== expectedBattles) failures.push(`aggregate-completed-${completedBattles}-of-${expectedBattles}`);
  if (authoritativeRollouts !== expectedBattles * 2) failures.push(`aggregate-rollouts-${authoritativeRollouts}-of-${expectedBattles * 2}`);

  const duplicateEliteIds = [];
  const seenEliteIds = new Set();
  for (const episode of eliteEpisodes) {
    const id = String(episode?.id || "");
    if (!id || seenEliteIds.has(id)) duplicateEliteIds.push(id || "missing-id");
    seenEliteIds.add(id);
    if (!(Number(episode?.advantage) > 0)) failures.push(`non-positive-elite-${id || "missing-id"}`);
    if (episode?.intervention && !(episode.intervention.started && Number(episode.intervention.appliedSamples) >= 2)) {
      failures.push(`incomplete-elite-intervention-${id || "missing-id"}`);
    }
  }
  if (duplicateEliteIds.length) failures.push(`duplicate-elite-ids-${duplicateEliteIds.length}`);
  if (eliteEpisodes.length < 8) failures.push(`insufficient-positive-elites-${eliteEpisodes.length}`);

  return {
    format: "echo-neural-selfplay-aggregate-v3",
    generatedAt: new Date().toISOString(),
    expectedBattles,
    completedBattles,
    authoritativeRollouts,
    startIndex: expectedStartIndex,
    endIndex: expectedStartIndex + expectedBattles,
    expectedShards,
    receivedShards: byShard.size,
    baselineOutcomeCounts,
    exploredOutcomeCounts,
    outcomeCounts: exploredOutcomeCounts,
    interventionCounts,
    positiveAdvantagePairs,
    advantageRange: {
      minimum: Number.isFinite(minimumAdvantage) ? minimumAdvantage : null,
      maximum: Number.isFinite(maximumAdvantage) ? maximumAdvantage : null,
      mean: completedBattles ? weightedAdvantage / completedBattles : null,
    },
    scoreRange: {
      minimum: Number.isFinite(minimumScore) ? minimumScore : null,
      maximum: Number.isFinite(maximumScore) ? maximumScore : null,
    },
    eliteEpisodes,
    failures,
    verdict: failures.length ? "incomplete" : "complete",
    critique: [
      "Coverage proves every declared pair and both authoritative rollouts, not that scripted players represent human play.",
      "Version-three pairs contain at most one coherent intervention, allowing a positive advantage to be assigned to one macro instead of hundreds of random actions.",
      "The aggregate contains only positive-advantage elite trajectories; losing interventions remain represented in counts and advantage statistics.",
      "A complete batch is still one campaign range and must not be described as a completed million-target campaign without contiguous range accounting.",
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
    if (["echo-neural-selfplay-elites-v1", "echo-neural-selfplay-elites-v2", "echo-neural-selfplay-elites-v3"].includes(parsed?.format)) reports.push(parsed);
  }
  const aggregate = mergeSelfPlayShards(reports, {expectedBattles, expectedShards, expectedStartIndex});
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    verdict: aggregate.verdict,
    completedPairs: aggregate.completedBattles,
    authoritativeRollouts: aggregate.authoritativeRollouts,
    positiveAdvantagePairs: aggregate.positiveAdvantagePairs,
    interventions: aggregate.interventionCounts,
    elites: aggregate.eliteEpisodes.length,
    failures: aggregate.failures,
  }, null, 2));
  if (aggregate.verdict !== "complete") process.exitCode = 4;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
