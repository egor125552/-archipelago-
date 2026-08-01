import {mkdir, writeFile} from "node:fs/promises";
import process from "node:process";

import {
  applyServerFreeInput,
  clearServerNeuralV2Overrides,
  createServerFreeRoom,
  neuralV2OverrideStatus,
  setServerFreePresence,
  setServerNeuralV2Override,
  startServerTrainingBattle,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {
  collectNeuralActors,
  neuralDecision,
  neuralPlayerPoint,
  neuralTargetForActor,
} from "../src/free-roam-neural-shadow.js";
import {neuralV2FeatureVector} from "../src/free-roam-neural-v2-features.js";
import {neuralV2RoleSpeed} from "../src/free-roam-neural-v2-control.js";
import {
  neuralV2PreferredRange,
  neuralV2SteeringOffset,
  neuralV2ThrottleScale,
} from "../src/free-roam-neural-v2-schema.js";
import {createNeuralV2HeadPlan} from "./generate_neural_v2_head_pairs.mjs";
import {withWorldRandomSeed} from "./generate_neural_selfplay_dataset.mjs";

const STEP_MS = 40;
const SAMPLE_MS = 200;
const FORMAT = "echo-neural-v2-head-windows-v1";
const HEADS = Object.freeze(["throttle", "steering", "range", "route", "fire"]);
const PLAYER_SCRIPTS = Object.freeze([
  "idle-no-fire",
  "water-zigzag",
  "water-escape",
  "aggressive",
  "shoreline",
  "damage-control",
]);
const WATER_MIN_X = 10;
const WATER_MAX_X = 410;
const WATER_MIN_Y = 82;
const WATER_MAX_Y = 310;
const SHORE_GATE_MIN_X = 118;
const SHORE_GATE_MAX_X = 302;
const SHORE_GATE_Y = 88;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const distance = (left, right) => Math.hypot(
  (Number(left?.x) || 0) - (Number(right?.x) || 0),
  (Number(left?.y) || 0) - (Number(right?.y) || 0),
);

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function integerArgument(name, fallback) {
  const value = Math.floor(Number(argument(name, fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function playerBoat(server, playerIndex) {
  const player = server.world.players?.[playerIndex];
  return server.world.boats?.find(candidate => candidate?.id === player?.activeBoat)
    || server.world.boats?.find(candidate => candidate?.owner === playerIndex)
    || null;
}

function nearestEnemyId(server, playerIndex) {
  const player = server.world.players?.[playerIndex];
  const point = ["boat", "roof"].includes(player?.mode) ? playerBoat(server, playerIndex) || player : player;
  if (!point) return null;
  return collectNeuralActors(server.world)
    .map(actor => ({id: actor.id, metres: distance(actor.entity, point)}))
    .sort((left, right) => left.metres - right.metres)[0]?.id || null;
}

function scriptedInput(script, elapsed, server, playerIndex) {
  const boat = playerBoat(server, playerIndex);
  const player = server.world.players?.[playerIndex];
  const cycle = Math.floor(elapsed / 1800) % 4;
  const targetId = nearestEnemyId(server, playerIndex);
  const attack = Boolean(targetId) && player?.combat?.alive !== false;
  const pulse = divisor => Math.floor(elapsed / divisor) % 2 === 0;
  const base = {
    targetId,
    navigationTargetId: "objective",
    attack,
    pump: Number(boat?.water) >= 8,
    repair: Number(boat?.leak) >= 0.7 && Math.abs(Number(boat?.speed) || 0) <= 3,
  };
  if (script === "idle-no-fire") return {...base, attack: false};
  if (script === "water-zigzag") return {...base, up: true, left: cycle < 2, right: cycle >= 2, attack: attack && pulse(500)};
  if (script === "water-escape") {
    const safe = Number(player?.combat?.health) > 25 && Number(boat?.hull) > 25;
    return {...base, up: true, left: cycle === 0 || cycle === 3, right: cycle === 1 || cycle === 2, attack: attack && safe && pulse(700)};
  }
  if (script === "aggressive") return {...base, up: true, left: cycle === 1, right: cycle === 3};
  if (script === "shoreline") {
    const y = Number(boat?.y) || 160;
    return {...base, up: y > 92, down: y < 84, left: cycle === 0, right: cycle === 2, attack: attack && pulse(800)};
  }
  const damaged = Number(boat?.water) >= 6 || Number(boat?.leak) >= 0.7 || Number(boat?.hull) <= 70;
  return {
    ...base,
    up: !damaged,
    down: damaged && Math.abs(Number(boat?.speed) || 0) > 1,
    left: !damaged && cycle < 2,
    right: !damaged && cycle >= 2,
    attack: !damaged && attack && pulse(600),
  };
}

function candidatesForHead(server, head) {
  const actors = collectNeuralActors(server.world);
  if (head === "fire") return actors.filter(actor => actor.controlsFire !== false);
  const moving = actors.filter(actor => actor.controlsMovement !== false
    && String(neuralDecision(server, actor.id)?.movement || "hold") !== "hold");
  if (head === "route") return moving.filter(actor => actor.kind === "boat");
  if (["steering", "range"].includes(head)) return moving;
  return actors.filter(actor => actor.controlsMovement !== false);
}

function gatePoint(targetPoint) {
  return {
    x: clamp(Number(targetPoint?.x) || 210, SHORE_GATE_MIN_X, SHORE_GATE_MAX_X),
    y: SHORE_GATE_Y,
  };
}

function boundaryMargin(actor) {
  if (actor?.kind !== "boat") return null;
  const entity = actor.entity;
  return Math.min(
    (Number(entity.x) || 0) - WATER_MIN_X,
    WATER_MAX_X - (Number(entity.x) || 0),
    (Number(entity.y) || 0) - WATER_MIN_Y,
    WATER_MAX_Y - (Number(entity.y) || 0),
  );
}

function captureState(server, actorId) {
  const actor = collectNeuralActors(server.world).find(item => item.id === actorId);
  if (!actor) return null;
  const targetEntry = neuralTargetForActor(server.world, actor);
  const targetPoint = targetEntry?.player ? neuralPlayerPoint(server.world, targetEntry.player) : null;
  if (!targetPoint) return null;
  const captain = server.world.players?.[0];
  const boat = playerBoat(server, 0);
  const decision = neuralDecision(server, actor.id);
  return {
    actorId: actor.id,
    role: actor.role,
    kind: actor.kind,
    x: Number(actor.entity?.x) || 0,
    y: Number(actor.entity?.y) || 0,
    heading: Number(actor.entity?.heading) || 0,
    speed: Number(actor.entity?.speed) || 0,
    targetX: Number(targetPoint.x) || 0,
    targetY: Number(targetPoint.y) || 0,
    targetDistance: distance(actor.entity, targetPoint),
    gateDistance: distance(actor.entity, gatePoint(targetPoint)),
    boundaryMargin: boundaryMargin(actor),
    baseMovement: String(decision?.movement || "hold"),
    baseFire: Boolean(decision?.fire),
    playerHealth: Math.max(0, Number(captain?.combat?.health) || 0),
    playerBoatHull: Math.max(0, Number(boat?.hull) || 0),
    playerBoatWater: Math.max(0, Number(boat?.water) || 0),
    features: neuralV2FeatureVector(server.world, actor, {stuckMs: 0}),
  };
}

function eventCounters(events, target = {}) {
  for (const event of events || []) {
    const type = String(event?.type || "");
    target[type] = (target[type] || 0) + 1;
  }
  return target;
}

function enemyPressureEvents(events) {
  return Object.entries(events || {}).reduce((sum, [type, count]) => {
    if (type === "heavy-bullet-boat-hit" || type === "gun-hit" || type.includes("ram-hit")) return sum + Number(count || 0);
    return sum;
  }, 0);
}

function clonePlan(plan, observeOnly) {
  return {
    ...plan,
    action: {...plan.action},
    observeOnly,
    started: false,
    completed: false,
    actorId: null,
    actorRole: null,
    actorKind: null,
    startedAtMs: null,
    endedAtMs: null,
    initialState: null,
    finalState: null,
  };
}

async function simulateWindow({battleIndex, worldSeed, level, script, coop, plan, maximumMs}) {
  return withWorldRandomSeed(worldSeed, async () => {
    const startedAt = 8_000_000 + battleIndex * (maximumMs + 5000);
    const server = createServerFreeRoom(startedAt);
    setServerFreePresence(server, "captain", true);
    if (coop) setServerFreePresence(server, "crew", true);
    startServerTrainingBattle(server, {level, neuralOnly: true}, false, startedAt + STEP_MS);
    const events = {};
    const windowMs = Math.max(SAMPLE_MS, Number(plan.durationSamples) * SAMPLE_MS);
    let captainSequence = 1;
    let crewSequence = 1;

    for (let elapsed = STEP_MS; elapsed <= maximumMs; elapsed += STEP_MS) {
      applyServerFreeInput(server, "captain", scriptedInput(script, elapsed, server, 0), captainSequence++);
      if (coop) {
        const crewScript = PLAYER_SCRIPTS[(PLAYER_SCRIPTS.indexOf(script) + 2) % PLAYER_SCRIPTS.length];
        applyServerFreeInput(server, "crew", scriptedInput(crewScript, elapsed + 700, server, 1), crewSequence++);
      }

      if (!plan.started && elapsed >= plan.startAtMs) {
        const candidates = candidatesForHead(server, plan.head);
        if (candidates.length) {
          const actor = candidates[Math.min(candidates.length - 1, Math.floor(plan.actorUnit * candidates.length))];
          plan.started = true;
          plan.startedAtMs = elapsed;
          plan.actorId = actor.id;
          plan.actorRole = actor.role;
          plan.actorKind = actor.kind;
          plan.initialState = captureState(server, actor.id);
          if (!plan.observeOnly) setServerNeuralV2Override(server, actor.id, {...plan.action, head: plan.head});
        }
      }

      const snapshot = tickServerFreeRoom(server, startedAt + STEP_MS + elapsed);
      if (plan.started) eventCounters(snapshot.events, events);
      if (plan.started && elapsed >= plan.startedAtMs + windowMs) {
        plan.finalState = captureState(server, plan.actorId);
        plan.completed = Boolean(plan.initialState && plan.finalState);
        plan.endedAtMs = elapsed;
        break;
      }
    }

    const diagnostics = neuralV2OverrideStatus(server).diagnostics;
    clearServerNeuralV2Overrides(server);
    return {
      started: plan.started,
      completed: plan.completed,
      actorId: plan.actorId,
      actorRole: plan.actorRole,
      actorKind: plan.actorKind,
      startedAtMs: plan.startedAtMs,
      endedAtMs: plan.endedAtMs,
      initialState: plan.initialState,
      finalState: plan.finalState,
      events,
      enemyPressureEvents: enemyPressureEvents(events),
      diagnostics,
    };
  });
}

function desiredSpeed(plan, state) {
  return neuralV2RoleSpeed({kind: state.kind, role: state.role}) * neuralV2ThrottleScale(plan.action);
}

export function compareNeuralV2HeadWindow(plan, baseline, explored) {
  const failures = [];
  if (!baseline?.completed) failures.push("baseline-window-incomplete");
  if (!explored?.completed) failures.push("explored-window-incomplete");
  if (baseline?.actorId !== explored?.actorId) failures.push("actor-id-mismatch");
  if (baseline?.actorRole !== explored?.actorRole || baseline?.actorKind !== explored?.actorKind) failures.push("actor-shape-mismatch");
  if (failures.length) return {valid: false, failures};

  const base = baseline.finalState;
  const test = explored.finalState;
  const headingSeparation = Math.abs(wrapDeg(test.heading - base.heading));
  const speedSeparation = Math.abs(test.speed - base.speed);
  const positionSeparation = distance(test, base);
  const targetDistanceDelta = base.targetDistance - test.targetDistance;
  const boundaryMarginDelta = Number(test.boundaryMargin ?? 0) - Number(base.boundaryMargin ?? 0);
  const gateDistanceDelta = base.gateDistance - test.gateDistance;
  const pressureDelta = explored.enemyPressureEvents - baseline.enemyPressureEvents;
  const playerDamageDelta = (baseline.initialState.playerHealth - baseline.finalState.playerHealth)
    - (explored.initialState.playerHealth - explored.finalState.playerHealth);
  const boatDamageDelta = (baseline.initialState.playerBoatHull - baseline.finalState.playerBoatHull)
    - (explored.initialState.playerBoatHull - explored.finalState.playerBoatHull);
  let objectiveDelta = 0;

  if (plan.head === "throttle") {
    const desired = desiredSpeed(plan, test);
    objectiveDelta = Math.abs(base.speed - desired) - Math.abs(test.speed - desired);
  } else if (plan.head === "steering") {
    const offset = neuralV2SteeringOffset(plan.action);
    const signed = wrapDeg(test.heading - base.heading);
    objectiveDelta = offset === 0 ? -Math.abs(signed) : Math.sign(offset) * signed;
  } else if (plan.head === "range") {
    const preferred = neuralV2PreferredRange(plan.action);
    objectiveDelta = Math.abs(base.targetDistance - preferred) - Math.abs(test.targetDistance - preferred);
  } else if (plan.head === "route") {
    if (plan.value === "safe_water") objectiveDelta = boundaryMarginDelta;
    else if (plan.value === "shore_gate") objectiveDelta = gateDistanceDelta;
    else objectiveDelta = targetDistanceDelta;
  } else if (plan.head === "fire") {
    objectiveDelta = plan.value === "fire" ? pressureDelta : -pressureDelta;
  }

  const effect = explored.diagnostics?.isolatedHeadEffects?.[plan.head] || {};
  const changed = Number(effect.changedFrames) > 0
    || headingSeparation > 0.25
    || speedSeparation > 0.05
    || positionSeparation > 0.01
    || pressureDelta !== 0;
  return {
    valid: true,
    failures: [],
    changed,
    objectiveDelta,
    headingSeparation,
    speedSeparation,
    positionSeparation,
    targetDistanceDelta,
    boundaryMarginDelta,
    gateDistanceDelta,
    pressureDelta,
    playerDamageDelta,
    boatDamageDelta,
    waterGuardDelta: Number(explored.diagnostics?.waterGuardInterventions || 0)
      - Number(baseline.diagnostics?.waterGuardInterventions || 0),
  };
}

export async function simulateNeuralV2HeadWindowPair({battleIndex, level, script, coop, maximumMs = 30_000}) {
  const headIndex = Math.abs(Math.floor(battleIndex)) % HEADS.length;
  const worldSeed = 28_725_552 + battleIndex * 10_007;
  const planSeed = 29_925_552 + battleIndex * 65_537;
  const basePlan = createNeuralV2HeadPlan(planSeed, level, maximumMs, headIndex);
  const baselinePlan = clonePlan(basePlan, true);
  const exploredPlan = clonePlan(basePlan, false);
  const baseline = await simulateWindow({battleIndex, worldSeed, level, script, coop, plan: baselinePlan, maximumMs});
  const explored = await simulateWindow({battleIndex, worldSeed, level, script, coop, plan: exploredPlan, maximumMs});
  const comparison = compareNeuralV2HeadWindow(exploredPlan, baseline, explored);
  return {
    id: `v2-head-window-${battleIndex}-${worldSeed}`,
    battleIndex,
    worldSeed,
    planSeed,
    level,
    script,
    coop,
    head: exploredPlan.head,
    value: exploredPlan.value,
    valueIndex: exploredPlan.valueIndex,
    durationSamples: exploredPlan.durationSamples,
    baseline,
    explored,
    comparison,
  };
}

function addStats(target, pair) {
  const head = pair.head;
  const stats = target[head] ||= {
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
  stats.pairs += 1;
  if (!pair.comparison.valid) return;
  stats.valid += 1;
  if (pair.comparison.changed) stats.changed += 1;
  if (pair.comparison.objectiveDelta > 0.001) stats.objectivePositive += 1;
  if (pair.comparison.objectiveDelta < -0.001) stats.objectiveNegative += 1;
  stats.objectiveSum += pair.comparison.objectiveDelta;
  stats.positionSeparationSum += pair.comparison.positionSeparation;
  stats.headingSeparationSum += pair.comparison.headingSeparation;
  stats.speedSeparationSum += pair.comparison.speedSeparation;
  stats.waterGuardDeltaSum += pair.comparison.waterGuardDelta;
}

async function main() {
  const battles = Math.max(1, integerArgument("battles", 256));
  const startIndex = integerArgument("start-index", 0);
  const shard = integerArgument("shard", 0);
  const shards = Math.max(1, integerArgument("shards", 1));
  const maximumMs = Math.max(8_000, integerArgument("maximum-ms", 30_000));
  const output = argument("output", `training/reports/v2-head-windows/shard-${shard}.json`);
  const pairs = [];
  const headStats = {};
  const endIndex = startIndex + battles;

  for (let battleIndex = startIndex + shard; battleIndex < endIndex; battleIndex += shards) {
    const relative = battleIndex - startIndex;
    const level = 2 + (relative % 4);
    const script = PLAYER_SCRIPTS[Math.floor(relative / 4) % PLAYER_SCRIPTS.length];
    const coop = relative % 5 === 0;
    const pair = await simulateNeuralV2HeadWindowPair({battleIndex, level, script, coop, maximumMs});
    pairs.push(pair);
    addStats(headStats, pair);
  }

  const validPairs = pairs.filter(pair => pair.comparison.valid);
  const diagnosticPairs = validPairs
    .sort((left, right) => Math.abs(right.comparison.objectiveDelta) - Math.abs(left.comparison.objectiveDelta))
    .slice(0, 40);
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
    maximumMs,
    validPairs: validPairs.length,
    invalidPairs: pairs.length - validPairs.length,
    changedPairs: validPairs.filter(pair => pair.comparison.changed).length,
    objectivePositivePairs: validPairs.filter(pair => pair.comparison.objectiveDelta > 0.001).length,
    headStats,
    diagnosticPairs,
    trainingEligiblePairs: [],
    critique: [
      "Baseline and explored select the same actor before their worlds diverge and observe the same fixed short window.",
      "Objective deltas test immediate head semantics and geometry; they are diagnostics, not reinforcement-learning rewards.",
      "The workflow cannot emit training labels or enable a model.",
      "Full-episode acceptance still requires the unchanged 2.5 threshold and separate fairness gates.",
    ],
  };
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(report)}\n`);
  console.log(JSON.stringify({
    output,
    completedPairs: pairs.length,
    authoritativeRollouts: pairs.length * 2,
    validPairs: report.validPairs,
    changedPairs: report.changedPairs,
    objectivePositivePairs: report.objectivePositivePairs,
    headStats,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
