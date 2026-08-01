import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import process from "node:process";

const FORMAT = "echo-neural-v2-head-windows-v1";
const HEADS = Object.freeze(["throttle", "steering", "range", "route", "fire"]);
const DIRECTIONAL_HEADS = new Set(["steering", "range", "route"]);

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

export function expectedWindowPairsForShard(totalPairs, shard, shards) {
  if (shard >= totalPairs) return 0;
  return Math.floor((totalPairs - 1 - shard) / shards) + 1;
}

function blankHeadStats() {
  return {
    pairs: 0,
    valid: 0,
    changed: 0,
    objectivePositive: 0,
    objectiveNegative: 0,
    objectiveSum: 0,
    positionSeparationSum: 0,
    headingSeparationSum: 0,
    speedSeparationSum: 0,
    waterGuardDeltaSum: 0,
  };
}

function mergeHeadStats(target, source = {}) {
  for (const key of Object.keys(target)) target[key] += Number(source[key]) || 0;
}

function finiteState(state) {
  if (!state || typeof state !== "object") return false;
  for (const key of [
    "x", "y", "heading", "speed", "targetX", "targetY", "targetDistance",
    "gateDistance", "playerHealth", "playerBoatHull", "playerBoatWater",
  ]) {
    if (!Number.isFinite(Number(state[key]))) return false;
  }
  if (state.boundaryMargin != null && !Number.isFinite(Number(state.boundaryMargin))) return false;
  return Array.isArray(state.features)
    && state.features.length === 53
    && state.features.every(Number.isFinite)
    && state.features.slice(-5).every(value => Number(value) === 0);
}

function symmetricDirectionalAssist(pair) {
  if (!DIRECTIONAL_HEADS.has(pair.head)) return true;
  const baselineFrames = Number(pair?.baseline?.diagnosticAssistFrames);
  const exploredFrames = Number(pair?.explored?.diagnosticAssistFrames);
  const comparisonFrames = Number(pair?.comparison?.diagnosticAssistFrames);
  return Number.isFinite(baselineFrames)
    && baselineFrames > 0
    && baselineFrames === exploredFrames
    && exploredFrames === comparisonFrames;
}

function validDiagnosticPair(pair) {
  if (!pair?.comparison?.valid) return false;
  if (!HEADS.includes(pair.head)) return false;
  if (!pair?.baseline?.completed || !pair?.explored?.completed) return false;
  if (!pair.baseline.actorId || pair.baseline.actorId !== pair.explored.actorId) return false;
  if (pair.baseline.actorRole !== pair.explored.actorRole || pair.baseline.actorKind !== pair.explored.actorKind) return false;
  if (!symmetricDirectionalAssist(pair)) return false;
  if (!finiteState(pair.baseline.initialState) || !finiteState(pair.baseline.finalState)) return false;
  if (!finiteState(pair.explored.initialState) || !finiteState(pair.explored.finalState)) return false;
  for (const key of [
    "objectiveDelta", "headingSeparation", "speedSeparation", "positionSeparation",
    "targetDistanceDelta", "boundaryMarginDelta", "gateDistanceDelta", "pressureDelta",
    "playerDamageDelta", "boatDamageDelta", "waterGuardDelta",
  ]) {
    if (!Number.isFinite(Number(pair.comparison[key]))) return false;
  }
  return true;
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
    list.sort((left, right) => Math.abs(Number(right.comparison.objectiveDelta))
      - Math.abs(Number(left.comparison.objectiveDelta))
      || Number(left.battleIndex) - Number(right.battleIndex));
    result.push(...list.slice(0, limit));
  }
  return result;
}

export function mergeNeuralV2HeadWindows(reports, {expectedPairs, expectedShards, expectedStartIndex}) {
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
  let validPairs = 0;
  let invalidPairs = 0;
  let changedPairs = 0;
  let objectivePositivePairs = 0;
  const headStats = Object.fromEntries(HEADS.map(head => [head, blankHeadStats()]));
  const diagnosticPairs = [];

  for (let shard = 0; shard < expectedShards; shard += 1) {
    const report = byShard.get(shard);
    if (!report) {
      failures.push(`missing-shard-${shard}`);
      continue;
    }
    const expectedLocal = expectedWindowPairsForShard(expectedPairs, shard, expectedShards);
    const localPairs = Number(report.completedPairs) || 0;
    const localRollouts = Number(report.authoritativeRollouts) || 0;
    if (report.format !== FORMAT) failures.push(`format-mismatch-${shard}`);
    if (Number(report.requestedPairs) !== expectedPairs) failures.push(`requested-pairs-mismatch-${shard}`);
    if (Number(report.startIndex) !== expectedStartIndex) failures.push(`start-index-mismatch-${shard}`);
    if (Number(report.endIndex) !== expectedStartIndex + expectedPairs) failures.push(`end-index-mismatch-${shard}`);
    if (Number(report.shards) !== expectedShards) failures.push(`shards-mismatch-${shard}`);
    if (localPairs !== expectedLocal) failures.push(`completed-pairs-mismatch-${shard}-${localPairs}-of-${expectedLocal}`);
    if (localRollouts !== localPairs * 2) failures.push(`rollouts-mismatch-${shard}-${localRollouts}-of-${localPairs * 2}`);
    if ((Number(report.validPairs) || 0) + (Number(report.invalidPairs) || 0) !== localPairs) {
      failures.push(`validity-count-mismatch-${shard}`);
    }
    if (Array.isArray(report.trainingEligiblePairs) && report.trainingEligiblePairs.length) {
      failures.push(`training-pairs-present-${shard}`);
    }
    const headPairTotal = Object.values(report.headStats || {}).reduce((sum, stats) => sum + (Number(stats?.pairs) || 0), 0);
    if (headPairTotal !== localPairs) failures.push(`head-count-mismatch-${shard}`);

    completedPairs += localPairs;
    authoritativeRollouts += localRollouts;
    validPairs += Number(report.validPairs) || 0;
    invalidPairs += Number(report.invalidPairs) || 0;
    changedPairs += Number(report.changedPairs) || 0;
    objectivePositivePairs += Number(report.objectivePositivePairs) || 0;
    for (const head of HEADS) mergeHeadStats(headStats[head], report.headStats?.[head]);

    for (const pair of report.diagnosticPairs || []) {
      if (!validDiagnosticPair(pair)) failures.push(`invalid-diagnostic-pair-${String(pair?.id || shard)}`);
      else diagnosticPairs.push(pair);
    }
  }

  if (completedPairs !== expectedPairs) failures.push(`aggregate-pairs-${completedPairs}-of-${expectedPairs}`);
  if (authoritativeRollouts !== expectedPairs * 2) failures.push(`aggregate-rollouts-${authoritativeRollouts}-of-${expectedPairs * 2}`);
  if (validPairs + invalidPairs !== completedPairs) failures.push("aggregate-validity-count-mismatch");
  for (const head of HEADS) if (!(headStats[head].pairs > 0)) failures.push(`missing-head-${head}`);
  const unique = uniquePairs(diagnosticPairs);
  if (unique.length !== diagnosticPairs.length) failures.push("duplicate-diagnostic-pair-id");
  const retained = uniquePairs([
    ...topByGroup(unique, pair => pair.head, 12),
    ...topByGroup(unique, pair => `${pair.head}:${pair.valueIndex}`, 6),
  ]).sort((left, right) => Math.abs(Number(right.comparison.objectiveDelta))
    - Math.abs(Number(left.comparison.objectiveDelta)));

  const headSummary = Object.fromEntries(HEADS.map(head => {
    const stats = headStats[head];
    return [head, {
      ...stats,
      validRate: stats.pairs ? stats.valid / stats.pairs : 0,
      changedRate: stats.valid ? stats.changed / stats.valid : 0,
      objectivePositiveRate: stats.valid ? stats.objectivePositive / stats.valid : 0,
      meanObjectiveDelta: stats.valid ? stats.objectiveSum / stats.valid : 0,
      meanPositionSeparation: stats.valid ? stats.positionSeparationSum / stats.valid : 0,
      meanHeadingSeparation: stats.valid ? stats.headingSeparationSum / stats.valid : 0,
      meanSpeedSeparation: stats.valid ? stats.speedSeparationSum / stats.valid : 0,
    }];
  }));

  return {
    format: "echo-neural-v2-head-windows-aggregate-v1",
    generatedAt: new Date().toISOString(),
    expectedPairs,
    completedPairs,
    authoritativeRollouts,
    startIndex: expectedStartIndex,
    endIndex: expectedStartIndex + expectedPairs,
    expectedShards,
    receivedShards: byShard.size,
    validPairs,
    invalidPairs,
    changedPairs,
    objectivePositivePairs,
    changedRate: validPairs ? changedPairs / validPairs : 0,
    objectivePositiveRate: validPairs ? objectivePositivePairs / validPairs : 0,
    headStats: headSummary,
    diagnosticPairs: retained,
    trainingEligiblePairs: [],
    failures,
    verdict: failures.length ? "invalid" : "complete-short-horizon-diagnostics",
    critique: [
      "Short-horizon objective deltas verify immediate semantics and geometry only; they are not full-episode rewards.",
      "Directional evidence is accepted only when baseline and explored use the same positive number of diagnostic motion-assist frames.",
      "A positive short-window result cannot become a training label until it also passes full-episode fairness and non-regression gates.",
      "Baseline and explored must retain the same actor identity and finite 53-value states.",
      "This aggregate cannot train, export or enable a model.",
    ],
  };
}

async function main() {
  const input = argument("input", "training/reports/v2-head-windows/input");
  const output = argument("output", "training/reports/v2-head-windows-aggregate.json");
  const expectedPairs = Math.max(1, integerArgument("expected-pairs", 256));
  const expectedShards = Math.max(1, integerArgument("expected-shards", 8));
  const expectedStartIndex = integerArgument("expected-start-index", 0);
  const reports = [];
  for (const file of await jsonFiles(input)) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.format === FORMAT) reports.push(parsed);
  }
  const aggregate = mergeNeuralV2HeadWindows(reports, {expectedPairs, expectedShards, expectedStartIndex});
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    verdict: aggregate.verdict,
    completedPairs: aggregate.completedPairs,
    authoritativeRollouts: aggregate.authoritativeRollouts,
    validPairs: aggregate.validPairs,
    changedPairs: aggregate.changedPairs,
    objectivePositivePairs: aggregate.objectivePositivePairs,
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
