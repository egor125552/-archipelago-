import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import process from "node:process";

import {
  NEURAL_V2_FIRE_CLASSES,
  NEURAL_V2_RANGE_CLASSES,
  NEURAL_V2_ROUTE_CLASSES,
  NEURAL_V2_STEERING_CLASSES,
  NEURAL_V2_THROTTLE_CLASSES,
} from "../src/free-roam-neural-v2-schema.js";

const REPORT_FORMAT = "echo-neural-v2-head-pairs-v1";
const HEADS = Object.freeze(["throttle", "steering", "range", "route", "fire"]);
const HEAD_CLASSES = Object.freeze({
  throttle: NEURAL_V2_THROTTLE_CLASSES,
  steering: NEURAL_V2_STEERING_CLASSES,
  range: NEURAL_V2_RANGE_CLASSES,
  route: NEURAL_V2_ROUTE_CLASSES,
  fire: NEURAL_V2_FIRE_CLASSES,
});
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

export function expectedHeadPairsForShard(totalPairs, shard, shards) {
  if (shard >= totalPairs) return 0;
  return Math.floor((totalPairs - 1 - shard) / shards) + 1;
}

function addCounts(target, source) {
  for (const [name, value] of Object.entries(source || {})) target[name] = (target[name] || 0) + (Number(value) || 0);
}

function validDiagnostics(diagnostics) {
  return DIAGNOSTIC_KEYS.every(key => Number.isFinite(Number(diagnostics?.[key])) && Number(diagnostics[key]) >= 0)
    && HEADS.every(head => Number.isFinite(Number(diagnostics?.isolatedHeadFrames?.[head])));
}

function zeroHistory(features) {
  return Array.isArray(features) && features.length === 53
    && features.every(Number.isFinite)
    && features.slice(-5).every(value => Number(value) === 0);
}

function validHeadValue(head, valueIndex) {
  return HEADS.includes(head)
    && Number.isInteger(valueIndex)
    && valueIndex >= 0
    && valueIndex < HEAD_CLASSES[head].length;
}

function finalTickProved(intervention) {
  return intervention?.completed === true
    && intervention?.finishAfterTick === false
    && Number(intervention?.controlledFramesAtEnd) > Number(intervention?.controlledFramesBeforeLastSample)
    && Number(intervention?.isolatedHeadFramesAtEnd) > Number(intervention?.isolatedHeadFramesBeforeLastSample);
}

export function mergeNeuralV2HeadShards(reports, {expectedPairs, expectedShards, expectedStartIndex}) {
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
  let advantageWeightedTotal = 0;
  let minimumAdvantage = Infinity;
  let maximumAdvantage = -Infinity;
  const baselineOutcomes = {};
  const exploredOutcomes = {};
  const headPairCounts = {};
  const positiveByHead = {};
  const valuePairCounts = {};
  const positiveByValue = {};
  const elitePairs = [];
  const integrity = {
    sampledPairs: 0,
    sampledFrames: 0,
    diagnosticPairs: 0,
    completedInterventions: 0,
    finalTickProofPairs: 0,
    isolatedHeadProofPairs: 0,
    waterGuardInterventions: 0,
  };

  for (let shard = 0; shard < expectedShards; shard += 1) {
    const report = byShard.get(shard);
    if (!report) {
      failures.push(`missing-shard-${shard}`);
      continue;
    }
    const expectedLocal = expectedHeadPairsForShard(expectedPairs, shard, expectedShards);
    const localPairs = Number(report.completedPairs) || 0;
    const localRollouts = Number(report.authoritativeRollouts) || 0;
    if (report.format !== REPORT_FORMAT) failures.push(`format-mismatch-${shard}`);
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
    const headTotal = Object.values(report.headPairCounts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    if (headTotal !== localPairs) failures.push(`head-count-mismatch-${shard}`);

    const localIntegrity = report.integrity || {};
    if (Number(localIntegrity.diagnosticPairs) !== localPairs) failures.push(`diagnostic-pairs-mismatch-${shard}`);
    if (Number(localIntegrity.nonZeroHistoryFrames) !== 0) failures.push(`nonzero-history-${shard}`);
    if (Number(localIntegrity.invalidDiagnosticPairs) !== 0) failures.push(`invalid-diagnostics-${shard}`);
    if (Number(localIntegrity.invalidFinalTickProofs) !== 0) failures.push(`invalid-final-ticks-${shard}`);
    if (Number(localIntegrity.invalidIsolatedHeadProofs) !== 0) failures.push(`invalid-head-proofs-${shard}`);
    if (Number(localIntegrity.finalTickProofPairs) !== Number(localIntegrity.completedInterventions)) failures.push(`final-tick-count-mismatch-${shard}`);
    if (Number(localIntegrity.isolatedHeadProofPairs) !== Number(localIntegrity.completedInterventions)) failures.push(`head-proof-count-mismatch-${shard}`);

    completedPairs += localPairs;
    authoritativeRollouts += localRollouts;
    positivePairs += Number(report.positivePairs) || 0;
    advantageWeightedTotal += (Number(report.advantageRange?.mean) || 0) * localPairs;
    minimumAdvantage = Math.min(minimumAdvantage, Number(report.advantageRange?.minimum));
    maximumAdvantage = Math.max(maximumAdvantage, Number(report.advantageRange?.maximum));
    addCounts(baselineOutcomes, report.baselineOutcomes);
    addCounts(exploredOutcomes, report.exploredOutcomes);
    addCounts(headPairCounts, report.headPairCounts);
    addCounts(positiveByHead, report.positiveByHead);
    addCounts(valuePairCounts, report.valuePairCounts);
    addCounts(positiveByValue, report.positiveByValue);
    for (const key of Object.keys(integrity)) integrity[key] += Number(localIntegrity[key]) || 0;

    for (const pair of report.elitePairs || []) {
      const id = String(pair?.id || "");
      if (!id) failures.push(`elite-without-id-${shard}`);
      if (!(Number(pair?.advantage) >= Number(report.minimumAdvantage))) failures.push(`elite-below-threshold-${id || shard}`);
      if (!validHeadValue(pair?.head, Number(pair?.valueIndex))) failures.push(`elite-invalid-head-value-${id || shard}`);
      if (pair?.intervention?.head !== pair?.head || Number(pair?.intervention?.valueIndex) !== Number(pair?.valueIndex)) {
        failures.push(`elite-label-mismatch-${id || shard}`);
      }
      if (!finalTickProved(pair?.intervention)) failures.push(`elite-unproved-intervention-${id || shard}`);
      if (!validDiagnostics(pair?.explored?.diagnostics)) failures.push(`elite-invalid-diagnostics-${id || shard}`);
      if (!(Number(pair?.explored?.diagnostics?.isolatedHeadFrames?.[pair.head]) > 0)) failures.push(`elite-head-not-applied-${id || shard}`);
      if (!Array.isArray(pair?.explored?.samples) || pair.explored.samples.length < 2) failures.push(`elite-missing-samples-${id || shard}`);
      for (const sample of pair?.explored?.samples || []) {
        if (!zeroHistory(sample.features)) {
          failures.push(`elite-invalid-features-${id || shard}`);
          break;
        }
        if (sample.head !== pair.head || Number(sample.valueIndex) !== Number(pair.valueIndex)) {
          failures.push(`elite-sample-label-mismatch-${id || shard}`);
          break;
        }
        if (!validHeadValue(sample.head, Number(sample.valueIndex))) {
          failures.push(`elite-invalid-sample-head-${id || shard}`);
          break;
        }
      }
      elitePairs.push(pair);
    }
  }

  if (completedPairs !== expectedPairs) failures.push(`aggregate-pairs-${completedPairs}-of-${expectedPairs}`);
  if (authoritativeRollouts !== expectedPairs * 2) failures.push(`aggregate-rollouts-${authoritativeRollouts}-of-${expectedPairs * 2}`);
  if (integrity.diagnosticPairs !== completedPairs) failures.push(`aggregate-diagnostics-${integrity.diagnosticPairs}-of-${completedPairs}`);
  if (integrity.finalTickProofPairs !== integrity.completedInterventions) failures.push("aggregate-final-tick-proof-mismatch");
  if (integrity.isolatedHeadProofPairs !== integrity.completedInterventions) failures.push("aggregate-head-proof-mismatch");
  for (const head of HEADS) if (!(Number(headPairCounts[head]) > 0)) failures.push(`missing-head-${head}`);
  const ids = elitePairs.map(pair => String(pair.id || ""));
  if (new Set(ids).size !== ids.length) failures.push("duplicate-elite-pair-id");

  return {
    format: "echo-neural-v2-head-pair-aggregate-v1",
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
    headPairCounts,
    positiveByHead,
    valuePairCounts,
    positiveByValue,
    integrity,
    baselineOutcomes,
    exploredOutcomes,
    advantageRange: {
      minimum: Number.isFinite(minimumAdvantage) ? minimumAdvantage : null,
      maximum: Number.isFinite(maximumAdvantage) ? maximumAdvantage : null,
      mean: completedPairs ? advantageWeightedTotal / completedPairs : null,
    },
    elitePairs,
    failures,
    verdict: failures.length ? "invalid" : "complete-single-head-discovery",
    critique: [
      "Every explored rollout changes one head only; positive examples are attributable to that named head and value.",
      "A complete aggregate does not guarantee enough positive coverage to train all five heads.",
      "Heads with no diverse positive values must remain untrained rather than borrowing labels from another head.",
      "No v2 model is trained or enabled by this aggregate.",
    ],
  };
}

async function main() {
  const input = argument("input", "training/reports/v2-head-pairs/input");
  const output = argument("output", "training/reports/v2-head-pairs-aggregate.json");
  const expectedPairs = Math.max(1, integerArgument("expected-pairs", 256));
  const expectedShards = Math.max(1, integerArgument("expected-shards", 8));
  const expectedStartIndex = integerArgument("expected-start-index", 0);
  const reports = [];
  for (const file of await jsonFiles(input)) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.format === REPORT_FORMAT) reports.push(parsed);
  }
  const aggregate = mergeNeuralV2HeadShards(reports, {expectedPairs, expectedShards, expectedStartIndex});
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    verdict: aggregate.verdict,
    completedPairs: aggregate.completedPairs,
    authoritativeRollouts: aggregate.authoritativeRollouts,
    positivePairs: aggregate.positivePairs,
    positiveByHead: aggregate.positiveByHead,
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
