import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import process from "node:process";

const FORMAT = "echo-neural-v2-head-diagnostics-v1";
const HEADS = Object.freeze(["throttle", "steering", "range", "route", "fire"]);
const HEAD_SIZES = Object.freeze({throttle: 4, steering: 5, range: 4, route: 3, fire: 2});
const THRESHOLDS = Object.freeze([0, 1, 2, 2.5]);
const DIAGNOSTIC_KEYS = Object.freeze([
  "preparedFrames",
  "controlledFrames",
  "movementFrames",
  "fireAllowedFrames",
  "fireSuppressedFrames",
  "waterClampFrames",
  "waterGuardInterventions",
  "missingActorFrames",
  "missingTargetFrames",
]);

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

export function expectedDiagnosticPairsForShard(totalPairs, shard, shards) {
  if (shard >= totalPairs) return 0;
  return Math.floor((totalPairs - 1 - shard) / shards) + 1;
}

function blankStats() {
  return {
    count: 0,
    eligible: 0,
    advantageSum: 0,
    minimum: null,
    maximum: null,
    thresholds: Object.fromEntries(THRESHOLDS.map(value => [String(value), 0])),
  };
}

function mergeStats(target, source = {}) {
  target.count += Number(source.count) || 0;
  target.eligible += Number(source.eligible) || 0;
  target.advantageSum += Number(source.advantageSum) || 0;
  const minimum = Number(source.minimum);
  const maximum = Number(source.maximum);
  if (Number.isFinite(minimum)) target.minimum = target.minimum == null ? minimum : Math.min(target.minimum, minimum);
  if (Number.isFinite(maximum)) target.maximum = target.maximum == null ? maximum : Math.max(target.maximum, maximum);
  for (const threshold of THRESHOLDS) {
    target.thresholds[String(threshold)] += Number(source.thresholds?.[String(threshold)]) || 0;
  }
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + (Number(value) || 0);
}

function validDiagnostics(diagnostics) {
  return DIAGNOSTIC_KEYS.every(key => Number.isFinite(Number(diagnostics?.[key])) && Number(diagnostics[key]) >= 0)
    && HEADS.every(head => Number.isFinite(Number(diagnostics?.isolatedHeadFrames?.[head])));
}

function validPair(pair) {
  const head = pair?.head;
  const valueIndex = Number(pair?.valueIndex);
  if (!HEADS.includes(head) || !Number.isInteger(valueIndex) || valueIndex < 0 || valueIndex >= HEAD_SIZES[head]) return false;
  if (!Number.isFinite(Number(pair?.advantage))) return false;
  if (!(pair?.intervention?.completed === true && pair?.intervention?.finishAfterTick === false)) return false;
  if (!(Number(pair.intervention.controlledFramesAtEnd) > Number(pair.intervention.controlledFramesBeforeLastSample))) return false;
  if (!(Number(pair.intervention.isolatedHeadFramesAtEnd) > Number(pair.intervention.isolatedHeadFramesBeforeLastSample))) return false;
  if (!validDiagnostics(pair?.explored?.diagnostics)) return false;
  if (!Array.isArray(pair?.explored?.samples) || pair.explored.samples.length < 2) return false;
  return pair.explored.samples.every(sample => sample?.head === head
    && Number(sample?.valueIndex) === valueIndex
    && Array.isArray(sample?.features)
    && sample.features.length === 53
    && sample.features.every(Number.isFinite)
    && sample.features.slice(-5).every(value => Number(value) === 0));
}

function topByGroup(pairs, keyFor, limit) {
  const groups = new Map();
  for (const pair of pairs) {
    const key = keyFor(pair);
    const list = groups.get(key) || [];
    list.push(pair);
    groups.set(key, list);
  }
  const result = [];
  for (const list of groups.values()) {
    list.sort((left, right) => Number(right.advantage) - Number(left.advantage) || Number(left.battleIndex) - Number(right.battleIndex));
    result.push(...list.slice(0, limit));
  }
  return result;
}

function uniquePairs(pairs) {
  const seen = new Set();
  return pairs.filter(pair => {
    const id = String(pair?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function mergeNeuralV2HeadDiagnostics(reports, {expectedPairs, expectedShards, expectedStartIndex}) {
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

  let completedPairs = 0;
  let authoritativeRollouts = 0;
  const headStats = Object.fromEntries(HEADS.map(head => [head, blankStats()]));
  const valueStats = {};
  const baselineOutcomes = {};
  const exploredOutcomes = {};
  const integrity = {
    eligiblePairs: 0,
    invalidPairs: 0,
    sampledFrames: 0,
    completedInterventions: 0,
    finalTickProofPairs: 0,
    isolatedHeadProofPairs: 0,
    waterGuardInterventions: 0,
  };
  const diagnosticPairs = [];

  for (let shard = 0; shard < expectedShards; shard += 1) {
    const report = byShard.get(shard);
    if (!report) {
      failures.push(`missing-shard-${shard}`);
      continue;
    }
    const expectedLocal = expectedDiagnosticPairsForShard(expectedPairs, shard, expectedShards);
    const localPairs = Number(report.completedPairs) || 0;
    const localRollouts = Number(report.authoritativeRollouts) || 0;
    if (report.format !== FORMAT) failures.push(`format-mismatch-${shard}`);
    if (Number(report.requestedPairs) !== expectedPairs) failures.push(`requested-pairs-mismatch-${shard}`);
    if (Number(report.startIndex) !== expectedStartIndex) failures.push(`start-index-mismatch-${shard}`);
    if (Number(report.endIndex) !== expectedStartIndex + expectedPairs) failures.push(`end-index-mismatch-${shard}`);
    if (Number(report.shards) !== expectedShards) failures.push(`shards-mismatch-${shard}`);
    if (localPairs !== expectedLocal) failures.push(`completed-pairs-mismatch-${shard}-${localPairs}-of-${expectedLocal}`);
    if (localRollouts !== localPairs * 2) failures.push(`rollouts-mismatch-${shard}`);
    const baselineTotal = Object.values(report.baselineOutcomes || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const exploredTotal = Object.values(report.exploredOutcomes || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    if (baselineTotal !== localPairs) failures.push(`baseline-outcomes-mismatch-${shard}`);
    if (exploredTotal !== localPairs) failures.push(`explored-outcomes-mismatch-${shard}`);
    if (Array.isArray(report.trainingEligiblePairs) && report.trainingEligiblePairs.length) failures.push(`training-pairs-present-${shard}`);

    completedPairs += localPairs;
    authoritativeRollouts += localRollouts;
    addCounts(baselineOutcomes, report.baselineOutcomes);
    addCounts(exploredOutcomes, report.exploredOutcomes);
    for (const head of HEADS) mergeStats(headStats[head], report.headStats?.[head]);
    for (const [key, stats] of Object.entries(report.valueStats || {})) {
      valueStats[key] ||= blankStats();
      mergeStats(valueStats[key], stats);
    }
    for (const key of Object.keys(integrity)) integrity[key] += Number(report.integrity?.[key]) || 0;
    for (const pair of report.diagnosticPairs || []) {
      if (!validPair(pair)) failures.push(`invalid-diagnostic-pair-${String(pair?.id || shard)}`);
      else diagnosticPairs.push(pair);
    }
  }

  if (completedPairs !== expectedPairs) failures.push(`aggregate-pairs-${completedPairs}-of-${expectedPairs}`);
  if (authoritativeRollouts !== expectedPairs * 2) failures.push(`aggregate-rollouts-${authoritativeRollouts}-of-${expectedPairs * 2}`);
  for (const head of HEADS) if (!(headStats[head].count > 0)) failures.push(`missing-head-${head}`);
  const unique = uniquePairs(diagnosticPairs);
  if (unique.length !== diagnosticPairs.length) failures.push("duplicate-diagnostic-pair-id");
  const retained = uniquePairs([
    ...topByGroup(unique, pair => pair.head, 8),
    ...topByGroup(unique, pair => `${pair.head}:${pair.valueIndex}`, 4),
  ]).sort((left, right) => Number(right.advantage) - Number(left.advantage));

  return {
    format: "echo-neural-v2-head-diagnostics-aggregate-v1",
    generatedAt: new Date().toISOString(),
    expectedPairs,
    completedPairs,
    authoritativeRollouts,
    startIndex: expectedStartIndex,
    endIndex: expectedStartIndex + expectedPairs,
    expectedShards,
    receivedShards: byShard.size,
    headStats,
    valueStats,
    integrity,
    baselineOutcomes,
    exploredOutcomes,
    diagnosticPairs: retained,
    trainingEligiblePairs: [],
    failures,
    verdict: failures.length ? "invalid" : "complete-diagnostic-batch",
    critique: [
      "This aggregate retains near misses for explanation only; no retained pair is a training label.",
      "Counts at 2.5 use the unchanged acceptance threshold, while lower thresholds describe score distribution only.",
      "A head with rare positive scores still requires diverse scenario and value coverage before a trainer can be built.",
      "No v2 model is trained or enabled by this workflow.",
    ],
  };
}

async function main() {
  const input = argument("input", "training/reports/v2-head-diagnostics/input");
  const output = argument("output", "training/reports/v2-head-diagnostics-aggregate.json");
  const expectedPairs = Math.max(1, integerArgument("expected-pairs", 1024));
  const expectedShards = Math.max(1, integerArgument("expected-shards", 16));
  const expectedStartIndex = integerArgument("expected-start-index", 0);
  const reports = [];
  for (const file of await jsonFiles(input)) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.format === FORMAT) reports.push(parsed);
  }
  const aggregate = mergeNeuralV2HeadDiagnostics(reports, {expectedPairs, expectedShards, expectedStartIndex});
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    verdict: aggregate.verdict,
    completedPairs: aggregate.completedPairs,
    authoritativeRollouts: aggregate.authoritativeRollouts,
    aboveThresholdByHead: Object.fromEntries(HEADS.map(head => [head, aggregate.headStats[head].thresholds["2.5"]])),
    retainedDiagnostics: aggregate.diagnosticPairs.length,
    failures: aggregate.failures,
  }, null, 2));
  if (aggregate.verdict === "invalid") process.exitCode = 4;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
