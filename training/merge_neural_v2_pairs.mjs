import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import process from "node:process";

import {
  NEURAL_V2_FIRE_CLASSES,
  NEURAL_V2_RANGE_CLASSES,
  NEURAL_V2_ROUTE_CLASSES,
  NEURAL_V2_STEERING_CLASSES,
  NEURAL_V2_THROTTLE_CLASSES,
} from "../src/free-roam-neural-v2-schema.js";

const PAIR_FORMAT = "echo-neural-v2-pairs-v2";
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

export function expectedPairsForShard(totalPairs, shard, shards) {
  if (shard >= totalPairs) return 0;
  return Math.floor((totalPairs - 1 - shard) / shards) + 1;
}

function addCounts(target, source) {
  for (const [name, value] of Object.entries(source || {})) target[name] = (target[name] || 0) + (Number(value) || 0);
}

function validActionTuple(action) {
  if (!Array.isArray(action) || action.length !== 5) return false;
  const sizes = [
    NEURAL_V2_THROTTLE_CLASSES.length,
    NEURAL_V2_STEERING_CLASSES.length,
    NEURAL_V2_RANGE_CLASSES.length,
    NEURAL_V2_ROUTE_CLASSES.length,
    NEURAL_V2_FIRE_CLASSES.length,
  ];
  return action.every((value, index) => Number.isInteger(value) && value >= 0 && value < sizes[index]);
}

function zeroHistory(features) {
  return Array.isArray(features)
    && features.length === 53
    && features.slice(-5).every(value => Number(value) === 0);
}

function validDiagnostics(diagnostics) {
  return DIAGNOSTIC_KEYS.every(key => Number.isFinite(Number(diagnostics?.[key])) && Number(diagnostics[key]) >= 0);
}

function finalTickProved(intervention) {
  return intervention?.completed === true
    && intervention?.finishAfterTick === false
    && Number.isFinite(Number(intervention?.controlledFramesBeforeLastSample))
    && Number.isFinite(Number(intervention?.controlledFramesAtEnd))
    && Number(intervention.controlledFramesAtEnd) > Number(intervention.controlledFramesBeforeLastSample);
}

function countAction(distribution, action) {
  const names = ["throttle", "steering", "range", "route", "fire"];
  for (let index = 0; index < names.length; index += 1) {
    const key = String(action[index]);
    distribution[names[index]][key] = (distribution[names[index]][key] || 0) + 1;
  }
}

export function mergeNeuralV2PairShards(reports, {expectedPairs, expectedShards, expectedStartIndex}) {
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
  let positivePairs = 0;
  let sampledPairs = 0;
  let sampledFrames = 0;
  let diagnosticPairs = 0;
  let completedInterventions = 0;
  let finalTickProofPairs = 0;
  let waterGuardInterventions = 0;
  let advantageWeightedTotal = 0;
  let minimumAdvantage = Infinity;
  let maximumAdvantage = -Infinity;
  const baselineOutcomes = {};
  const exploredOutcomes = {};
  const elitePairs = [];
  const actionDistribution = {throttle: {}, steering: {}, range: {}, route: {}, fire: {}};

  for (let shard = 0; shard < expectedShards; shard += 1) {
    const report = byShard.get(shard);
    if (!report) {
      failures.push(`missing-shard-${shard}`);
      continue;
    }
    const expectedLocal = expectedPairsForShard(expectedPairs, shard, expectedShards);
    const localPairs = Number(report.completedPairs) || 0;
    const localRollouts = Number(report.authoritativeRollouts) || 0;
    if (report.format !== PAIR_FORMAT) failures.push(`format-mismatch-${shard}`);
    if (Number(report.requestedPairs) !== expectedPairs) failures.push(`requested-pairs-mismatch-${shard}`);
    if (Number(report.startIndex) !== expectedStartIndex) failures.push(`start-index-mismatch-${shard}`);
    if (Number(report.endIndex) !== expectedStartIndex + expectedPairs) failures.push(`end-index-mismatch-${shard}`);
    if (Number(report.shards) !== expectedShards) failures.push(`shards-mismatch-${shard}`);
    if (localPairs !== expectedLocal) failures.push(`completed-pairs-mismatch-${shard}-${localPairs}-of-${expectedLocal}`);
    if (localRollouts !== localPairs * 2) failures.push(`rollouts-mismatch-${shard}-${localRollouts}-of-${localPairs * 2}`);
    const baselineTotal = Object.values(report.baselineOutcomes || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const exploredTotal = Object.values(report.exploredOutcomes || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    if (baselineTotal !== localPairs) failures.push(`baseline-outcomes-mismatch-${shard}`);
    if (exploredTotal !== localPairs) failures.push(`explored-outcomes-mismatch-${shard}`);

    const integrity = report.integrity || {};
    if (Number(integrity.diagnosticPairs) !== localPairs) failures.push(`diagnostic-pairs-mismatch-${shard}`);
    if (Number(integrity.nonZeroHistoryFrames) !== 0) failures.push(`nonzero-history-frames-${shard}-${Number(integrity.nonZeroHistoryFrames) || 0}`);
    if (Number(integrity.invalidDiagnosticPairs) !== 0) failures.push(`invalid-diagnostic-pairs-${shard}-${Number(integrity.invalidDiagnosticPairs) || 0}`);
    if (Number(integrity.invalidFinalTickProofs) !== 0) failures.push(`invalid-final-tick-proofs-${shard}-${Number(integrity.invalidFinalTickProofs) || 0}`);
    if (Number(integrity.finalTickProofPairs) !== Number(integrity.completedInterventions)) failures.push(`final-tick-proof-count-mismatch-${shard}`);
    if (Number(integrity.sampledFrames) < Number(integrity.sampledPairs) * 2) failures.push(`insufficient-sampled-frames-${shard}`);

    completedPairs += localPairs;
    authoritativeRollouts += localRollouts;
    positivePairs += Number(report.positivePairs) || 0;
    sampledPairs += Number(integrity.sampledPairs) || 0;
    sampledFrames += Number(integrity.sampledFrames) || 0;
    diagnosticPairs += Number(integrity.diagnosticPairs) || 0;
    completedInterventions += Number(integrity.completedInterventions) || 0;
    finalTickProofPairs += Number(integrity.finalTickProofPairs) || 0;
    waterGuardInterventions += Number(integrity.waterGuardInterventions) || 0;
    addCounts(baselineOutcomes, report.baselineOutcomes);
    addCounts(exploredOutcomes, report.exploredOutcomes);
    advantageWeightedTotal += (Number(report.advantageRange?.mean) || 0) * localPairs;
    minimumAdvantage = Math.min(minimumAdvantage, Number(report.advantageRange?.minimum));
    maximumAdvantage = Math.max(maximumAdvantage, Number(report.advantageRange?.maximum));

    for (const pair of report.elitePairs || []) {
      const id = String(pair?.id || "");
      if (!id) failures.push(`elite-without-id-${shard}`);
      if (!(Number(pair?.advantage) >= Number(report.minimumAdvantage))) failures.push(`elite-below-threshold-${id || shard}`);
      if (!(pair?.intervention?.started && Number(pair.intervention.appliedSamples) >= 2 && finalTickProved(pair.intervention))) {
        failures.push(`elite-incomplete-intervention-${id || shard}`);
      }
      if (!validDiagnostics(pair?.explored?.diagnostics)) failures.push(`elite-invalid-diagnostics-${id || shard}`);
      if (Number(pair?.explored?.diagnostics?.controlledFrames) < Number(pair?.intervention?.controlledFramesAtEnd)) {
        failures.push(`elite-diagnostics-before-final-tick-${id || shard}`);
      }
      if (!Array.isArray(pair?.explored?.samples) || pair.explored.samples.length < 2) failures.push(`elite-missing-samples-${id || shard}`);
      const tuple = pair?.explored?.samples?.[0]?.action;
      if (!validActionTuple(tuple)) failures.push(`elite-invalid-action-${id || shard}`);
      else countAction(actionDistribution, tuple);
      for (const sample of pair?.explored?.samples || []) {
        if (!Array.isArray(sample.features) || sample.features.length !== 53 || !sample.features.every(Number.isFinite)) {
          failures.push(`elite-invalid-features-${id || shard}`);
          break;
        }
        if (!zeroHistory(sample.features)) {
          failures.push(`elite-nonzero-history-${id || shard}`);
          break;
        }
        if (!validActionTuple(sample.action)) {
          failures.push(`elite-invalid-sample-action-${id || shard}`);
          break;
        }
      }
      elitePairs.push(pair);
    }
  }

  if (completedPairs !== expectedPairs) failures.push(`aggregate-pairs-${completedPairs}-of-${expectedPairs}`);
  if (authoritativeRollouts !== expectedPairs * 2) failures.push(`aggregate-rollouts-${authoritativeRollouts}-of-${expectedPairs * 2}`);
  if (diagnosticPairs !== completedPairs) failures.push(`aggregate-diagnostic-pairs-${diagnosticPairs}-of-${completedPairs}`);
  if (finalTickProofPairs !== completedInterventions) failures.push(`aggregate-final-tick-proofs-${finalTickProofPairs}-of-${completedInterventions}`);
  const ids = elitePairs.map(pair => String(pair.id || ""));
  if (new Set(ids).size !== ids.length) failures.push("duplicate-elite-pair-id");

  return {
    format: "echo-neural-v2-pair-aggregate-v2",
    generatedAt: new Date().toISOString(),
    expectedPairs,
    completedPairs,
    authoritativeRollouts,
    startIndex: expectedStartIndex,
    endIndex: expectedStartIndex + expectedPairs,
    expectedShards,
    receivedShards: byShard.size,
    positivePairs,
    positivePairRate: completedPairs ? positivePairs / completedPairs : 0,
    integrity: {
      sampledPairs,
      sampledFrames,
      diagnosticPairs,
      completedInterventions,
      finalTickProofPairs,
      waterGuardInterventions,
    },
    baselineOutcomes,
    exploredOutcomes,
    advantageRange: {
      minimum: Number.isFinite(minimumAdvantage) ? minimumAdvantage : null,
      maximum: Number.isFinite(maximumAdvantage) ? maximumAdvantage : null,
      mean: completedPairs ? advantageWeightedTotal / completedPairs : null,
    },
    actionDistribution,
    elitePairs,
    failures,
    verdict: failures.length ? "invalid" : "complete-discovery-batch",
    critique: [
      "A complete discovery batch proves pair, history, diagnostic and final-tick integrity, not that enough useful v2 actions were found.",
      "Zero or few positive pairs are valid evidence that the random multi-head proposal distribution is weak; the threshold must not be lowered merely to manufacture training data.",
      "The five heads are held together, so a positive pair cannot yet isolate which head caused the gain.",
      "No v2 model is trained or enabled by this aggregate.",
    ],
  };
}

async function main() {
  const input = argument("input", "training/reports/v2-pairs/input");
  const output = argument("output", "training/reports/v2-pairs-aggregate.json");
  const expectedPairs = Math.max(1, integerArgument("expected-pairs", 256));
  const expectedShards = Math.max(1, integerArgument("expected-shards", 8));
  const expectedStartIndex = integerArgument("expected-start-index", 0);
  const reports = [];
  for (const file of await jsonFiles(input)) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.format === PAIR_FORMAT) reports.push(parsed);
  }
  const aggregate = mergeNeuralV2PairShards(reports, {expectedPairs, expectedShards, expectedStartIndex});
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    verdict: aggregate.verdict,
    completedPairs: aggregate.completedPairs,
    authoritativeRollouts: aggregate.authoritativeRollouts,
    positivePairs: aggregate.positivePairs,
    elites: aggregate.elitePairs.length,
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
