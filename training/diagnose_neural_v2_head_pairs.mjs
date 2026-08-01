import {mkdir, writeFile} from "node:fs/promises";
import process from "node:process";

import {simulateNeuralV2HeadPair} from "./generate_neural_v2_head_pairs.mjs";

const FORMAT = "echo-neural-v2-head-diagnostics-v1";
const HEADS = Object.freeze(["throttle", "steering", "range", "route", "fire"]);
const HEAD_SIZES = Object.freeze({throttle: 4, steering: 5, range: 4, route: 3, fire: 2});
const PLAYER_SCRIPTS = Object.freeze([
  "idle-no-fire",
  "water-zigzag",
  "water-escape",
  "aggressive",
  "shoreline",
  "damage-control",
]);
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
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function integerArgument(name, fallback) {
  const value = Math.floor(Number(argument(name, fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function validDiagnostics(diagnostics) {
  return DIAGNOSTIC_KEYS.every(key => Number.isFinite(Number(diagnostics?.[key])) && Number(diagnostics[key]) >= 0)
    && HEADS.every(head => Number.isFinite(Number(diagnostics?.isolatedHeadFrames?.[head])));
}

function finalTickProved(intervention) {
  return intervention?.completed === true
    && intervention?.finishAfterTick === false
    && Number(intervention?.controlledFramesAtEnd) > Number(intervention?.controlledFramesBeforeLastSample)
    && Number(intervention?.isolatedHeadFramesAtEnd) > Number(intervention?.isolatedHeadFramesBeforeLastSample);
}

function diagnosticEligible(pair) {
  return HEADS.includes(pair?.head)
    && Number.isInteger(Number(pair?.valueIndex))
    && Number(pair.valueIndex) >= 0
    && Number(pair.valueIndex) < HEAD_SIZES[pair.head]
    && pair?.intervention?.started
    && Number(pair.intervention?.appliedSamples) >= 2
    && finalTickProved(pair.intervention)
    && validDiagnostics(pair?.explored?.diagnostics)
    && Array.isArray(pair?.explored?.samples)
    && pair.explored.samples.length >= 2
    && pair.explored.samples.every(sample => sample?.head === pair.head
      && Number(sample?.valueIndex) === Number(pair.valueIndex)
      && Array.isArray(sample?.features)
      && sample.features.length === 53
      && sample.features.every(Number.isFinite)
      && sample.features.slice(-5).every(value => Number(value) === 0));
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

function addStat(stats, pair, eligible) {
  const advantage = Number(pair.advantage) || 0;
  stats.count += 1;
  if (eligible) stats.eligible += 1;
  stats.advantageSum += advantage;
  stats.minimum = stats.minimum == null ? advantage : Math.min(stats.minimum, advantage);
  stats.maximum = stats.maximum == null ? advantage : Math.max(stats.maximum, advantage);
  for (const threshold of THRESHOLDS) {
    if (eligible && advantage >= threshold) stats.thresholds[String(threshold)] += 1;
  }
}

function topByGroup(pairs, keyFor, limit) {
  const groups = new Map();
  for (const pair of pairs) {
    if (!diagnosticEligible(pair)) continue;
    const key = keyFor(pair);
    const list = groups.get(key) || [];
    list.push(pair);
    groups.set(key, list);
  }
  const selected = [];
  for (const list of groups.values()) {
    list.sort((left, right) => Number(right.advantage) - Number(left.advantage) || Number(left.battleIndex) - Number(right.battleIndex));
    selected.push(...list.slice(0, limit));
  }
  return selected;
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

async function main() {
  const battles = Math.max(1, integerArgument("battles", 1024));
  const startIndex = integerArgument("start-index", 0);
  const shard = integerArgument("shard", 0);
  const shards = Math.max(1, integerArgument("shards", 16));
  const durationMs = Math.max(8_000, integerArgument("duration-ms", 45_000));
  const output = argument("output", `training/reports/v2-head-diagnostics/shard-${shard}.json`);
  const pairs = [];
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
  const endIndex = startIndex + battles;

  for (let battleIndex = startIndex + shard; battleIndex < endIndex; battleIndex += shards) {
    const relative = battleIndex - startIndex;
    const level = 2 + (relative % 4);
    const script = PLAYER_SCRIPTS[Math.floor(relative / 4) % PLAYER_SCRIPTS.length];
    const coop = relative % 5 === 0;
    const pair = await simulateNeuralV2HeadPair({battleIndex, durationMs, level, script, coop});
    pairs.push(pair);
    baselineOutcomes[pair.baseline.outcome] = (baselineOutcomes[pair.baseline.outcome] || 0) + 1;
    exploredOutcomes[pair.explored.outcome] = (exploredOutcomes[pair.explored.outcome] || 0) + 1;
    const eligible = diagnosticEligible(pair);
    addStat(headStats[pair.head], pair, eligible);
    const valueKey = `${pair.head}:${pair.valueIndex}`;
    valueStats[valueKey] ||= blankStats();
    addStat(valueStats[valueKey], pair, eligible);
    if (eligible) integrity.eligiblePairs += 1;
    else integrity.invalidPairs += 1;
    integrity.sampledFrames += pair.explored?.samples?.length || 0;
    const fullyCompleted = pair.intervention?.completed
      && Number(pair.intervention?.appliedSamples) === Number(pair.intervention?.durationSamples);
    if (fullyCompleted) integrity.completedInterventions += 1;
    if (fullyCompleted && Number(pair.intervention?.controlledFramesAtEnd) > Number(pair.intervention?.controlledFramesBeforeLastSample)) {
      integrity.finalTickProofPairs += 1;
    }
    if (fullyCompleted && Number(pair.intervention?.isolatedHeadFramesAtEnd) > Number(pair.intervention?.isolatedHeadFramesBeforeLastSample)) {
      integrity.isolatedHeadProofPairs += 1;
    }
    integrity.waterGuardInterventions += Number(pair.explored?.diagnostics?.waterGuardInterventions) || 0;
  }

  const diagnosticPairs = uniquePairs([
    ...topByGroup(pairs, pair => pair.head, 4),
    ...topByGroup(pairs, pair => `${pair.head}:${pair.valueIndex}`, 2),
  ]).sort((left, right) => Number(right.advantage) - Number(left.advantage));

  const report = {
    format: FORMAT,
    generatedAt: new Date().toISOString(),
    requestedPairs: battles,
    completedPairs: pairs.length,
    authoritativeRollouts: pairs.length * 2,
    startIndex,
    endIndex,
    shard,
    shards,
    durationMs,
    headStats,
    valueStats,
    integrity,
    baselineOutcomes,
    exploredOutcomes,
    diagnosticPairs,
    trainingEligiblePairs: [],
    critique: [
      "Diagnostic pairs are retained below the 2.5 training threshold to explain near misses; they are not training examples.",
      "Each explored rollout changes one isolated head over the unchanged v1 controller.",
      "The 2.5 threshold is reported unchanged and is not relaxed by this workflow.",
      "A larger sample can reveal whether useful effects are rare, head-specific or value-specific without publishing a model.",
    ],
  };
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(report)}\n`);
  console.log(JSON.stringify({
    output,
    completedPairs: pairs.length,
    authoritativeRollouts: pairs.length * 2,
    eligiblePairs: integrity.eligiblePairs,
    diagnosticPairs: diagnosticPairs.length,
    aboveThresholdByHead: Object.fromEntries(HEADS.map(head => [head, headStats[head].thresholds["2.5"]])),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
