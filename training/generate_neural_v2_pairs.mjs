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
  neuralPlayerPoint,
  neuralTargetForActor,
} from "../src/free-roam-neural-shadow.js";
import {neuralV2FeatureVector} from "../src/free-roam-neural-v2-features.js";
import {
  NEURAL_V2_FIRE_CLASSES,
  NEURAL_V2_RANGE_CLASSES,
  NEURAL_V2_ROUTE_CLASSES,
  NEURAL_V2_STEERING_CLASSES,
  NEURAL_V2_THROTTLE_CLASSES,
  normalizeNeuralV2Action,
} from "../src/free-roam-neural-v2-schema.js";
import {seededRandom, selfPlayScore, withWorldRandomSeed} from "./generate_neural_selfplay_dataset.mjs";

const STEP_MS = 40;
const SAMPLE_MS = 200;
const PLAYER_SCRIPTS = Object.freeze([
  "idle-no-fire",
  "water-zigzag",
  "water-escape",
  "aggressive",
  "shoreline",
  "damage-control",
]);

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function integerArgument(name, fallback) {
  const value = Math.floor(Number(argument(name, fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function numberArgument(name, fallback) {
  const value = Number(argument(name, fallback));
  return Number.isFinite(value) ? value : fallback;
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
    .map(actor => ({
      id: actor.id,
      metres: Math.hypot(
        (Number(actor.entity?.x) || 0) - (Number(point.x) || 0),
        (Number(actor.entity?.y) || 0) - (Number(point.y) || 0),
      ),
    }))
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

function presentIndices(world) {
  return (world.players || []).map((_player, index) => index).filter(index => Boolean(world.freeActivities?.presence?.[index]));
}

function allPlayersDown(world) {
  const indices = presentIndices(world);
  return indices.length > 0 && indices.every(index => world.players?.[index]?.combat?.alive === false);
}

function threatAwareStartWindow(level, durationMs) {
  const maximum = level === 2 ? 2200 : level === 3 ? 6000 : level === 4 ? 12000 : 22000;
  return Math.max(600, Math.min(durationMs - 3000, maximum));
}

function classIndex(random, classes) {
  return Math.min(classes.length - 1, Math.floor(random() * classes.length));
}

export function createNeuralV2PairPlan(seed, level, durationMs) {
  const random = seededRandom(seed);
  const maximumStart = threatAwareStartWindow(level, durationMs);
  return {
    startAtMs: 400 + Math.floor(random() * Math.max(1, maximumStart - 400)),
    durationSamples: 4 + Math.floor(random() * 8),
    actorUnit: random(),
    preferTurret: random() < 0.12,
    action: normalizeNeuralV2Action({
      throttleIndex: classIndex(random, NEURAL_V2_THROTTLE_CLASSES),
      steeringIndex: classIndex(random, NEURAL_V2_STEERING_CLASSES),
      rangeIndex: classIndex(random, NEURAL_V2_RANGE_CLASSES),
      routeIndex: classIndex(random, NEURAL_V2_ROUTE_CLASSES),
      fireIndex: classIndex(random, NEURAL_V2_FIRE_CLASSES),
      source: "paired-v2-macro",
    }),
    started: false,
    completed: false,
    actorId: null,
    actorRole: null,
    actorKind: null,
    startedAtMs: null,
    endedAtMs: null,
    appliedSamples: 0,
  };
}

function startPlanIfReady(server, plan, elapsedMs) {
  if (!plan || plan.started || plan.completed || elapsedMs < plan.startAtMs) return;
  const actors = collectNeuralActors(server.world);
  let candidates = plan.preferTurret
    ? actors.filter(actor => actor.controlsFire !== false)
    : actors.filter(actor => actor.controlsMovement !== false);
  if (!candidates.length) candidates = actors;
  if (!candidates.length) return;
  const actor = candidates[Math.min(candidates.length - 1, Math.floor(plan.actorUnit * candidates.length))];
  plan.actorId = actor.id;
  plan.actorRole = actor.role;
  plan.actorKind = actor.kind;
  plan.started = true;
  plan.startedAtMs = elapsedMs;
  setServerNeuralV2Override(server, actor.id, plan.action);
}

function samplePlan(server, plan, elapsedMs, samples) {
  if (!plan?.started || plan.completed || !plan.actorId) return;
  const actor = collectNeuralActors(server.world).find(item => item.id === plan.actorId);
  if (!actor) {
    plan.completed = true;
    plan.endedAtMs = elapsedMs;
    clearServerNeuralV2Overrides(server);
    return;
  }
  const targetEntry = neuralTargetForActor(server.world, actor);
  const targetPoint = targetEntry?.player ? neuralPlayerPoint(server.world, targetEntry.player) : null;
  samples.push({
    t: elapsedMs,
    actorId: actor.id,
    role: actor.role,
    kind: actor.kind,
    target: targetPoint ? [targetPoint.x, targetPoint.y, targetEntry.index] : null,
    // Previous-action heads are deliberately zero here. The current v2 label
    // must never be copied into its own recurrent input fields.
    features: neuralV2FeatureVector(server.world, actor, {stuckMs: 0}),
    action: [
      plan.action.throttleIndex,
      plan.action.steeringIndex,
      plan.action.rangeIndex,
      plan.action.routeIndex,
      plan.action.fireIndex,
    ],
  });
  plan.appliedSamples += 1;
  if (plan.appliedSamples >= plan.durationSamples) {
    plan.completed = true;
    plan.endedAtMs = elapsedMs;
    clearServerNeuralV2Overrides(server);
  }
}

async function simulateRollout({battleIndex, worldSeed, durationMs, level, script, coop, plan}) {
  return withWorldRandomSeed(worldSeed, async () => {
    const startedAt = 4_000_000 + battleIndex * (durationMs + 5000);
    const server = createServerFreeRoom(startedAt);
    setServerFreePresence(server, "captain", true);
    if (coop) setServerFreePresence(server, "crew", true);
    startServerTrainingBattle(server, {level, neuralOnly: true}, false, startedAt + STEP_MS);
    const samples = [];
    let nextSampleAt = 0;
    let elapsedMs = 0;
    let outcome = "timeout";
    let enemyHits = 0;
    let captainSequence = 1;
    let crewSequence = 1;

    for (let elapsed = STEP_MS; elapsed <= durationMs; elapsed += STEP_MS) {
      elapsedMs = elapsed;
      applyServerFreeInput(server, "captain", scriptedInput(script, elapsed, server, 0), captainSequence++);
      if (coop) {
        const crewScript = PLAYER_SCRIPTS[(PLAYER_SCRIPTS.indexOf(script) + 2) % PLAYER_SCRIPTS.length];
        applyServerFreeInput(server, "crew", scriptedInput(crewScript, elapsed + 700, server, 1), crewSequence++);
      }
      if (plan) startPlanIfReady(server, plan, elapsed);
      if (plan && elapsed >= nextSampleAt) {
        samplePlan(server, plan, elapsed, samples);
        nextSampleAt = elapsed + SAMPLE_MS;
      }
      const snapshot = tickServerFreeRoom(server, startedAt + STEP_MS + elapsed);
      for (const event of snapshot.events || []) {
        const type = String(event?.type || "");
        if (type === "heavy-bullet-boat-hit" || type === "gun-hit" || type.includes("ram-hit")) enemyHits += 1;
      }
      if ((snapshot.events || []).some(event => event?.type === "contract-threat-cleared")
        || (!server.world.freeThreatDirector?.active && server.world.freeThreatDirector?.cleared)) {
        outcome = "victory";
        break;
      }
      if (allPlayersDown(server.world)) {
        outcome = "team-wipe";
        break;
      }
    }

    const overrideDiagnostics = neuralV2OverrideStatus(server).diagnostics;
    clearServerNeuralV2Overrides(server);
    const player = server.world.players?.[0];
    const boat = playerBoat(server, 0);
    const playerHealth = Math.max(0, Number(player?.combat?.health) || 0);
    const boatHull = Math.max(0, Number(boat?.hull) || 0);
    const boatWater = Math.max(0, Number(boat?.water) || 0);
    const score = selfPlayScore({
      outcome,
      playerHealth,
      boatHull,
      boatWater,
      enemyHits,
      elapsedMs,
      durationMs,
      diagnostics: overrideDiagnostics,
    });
    return {
      outcome,
      elapsedMs,
      playerHealth,
      boatHull,
      boatWater,
      enemyHits,
      score,
      diagnostics: overrideDiagnostics,
      samples,
    };
  });
}

export async function simulateNeuralV2Pair({battleIndex, durationMs, level, script, coop}) {
  const worldSeed = 8_725_552 + battleIndex * 10_007;
  const planSeed = 9_925_552 + battleIndex * 65_537;
  const baseline = await simulateRollout({battleIndex, worldSeed, durationMs, level, script, coop, plan: null});
  const plan = createNeuralV2PairPlan(planSeed, level, durationMs);
  const explored = await simulateRollout({battleIndex, worldSeed, durationMs, level, script, coop, plan});
  return {
    id: `v2-pair-${battleIndex}-${worldSeed}`,
    battleIndex,
    seed: worldSeed,
    planSeed,
    level,
    script,
    coop,
    advantage: Math.round((explored.score - baseline.score) * 1000) / 1000,
    baseline,
    explored,
    intervention: plan,
  };
}

function usablePair(pair, minimumAdvantage) {
  return pair.advantage >= minimumAdvantage
    && pair.intervention?.started
    && pair.intervention?.appliedSamples >= 2
    && pair.explored?.samples?.length >= 2;
}

export function selectNeuralV2Elites(pairs, perGroup = 1, minimumAdvantage = 2.5) {
  const groups = new Map();
  for (const pair of pairs) {
    if (!usablePair(pair, minimumAdvantage)) continue;
    const key = `${pair.level}:${pair.script}:${pair.coop ? "coop" : "solo"}:${pair.intervention.actorRole || "unknown"}`;
    const list = groups.get(key) || [];
    list.push(pair);
    groups.set(key, list);
  }
  const selected = [];
  for (const list of groups.values()) {
    list.sort((left, right) => right.advantage - left.advantage || left.battleIndex - right.battleIndex);
    selected.push(...list.slice(0, Math.max(1, perGroup)));
  }
  return selected.sort((left, right) => left.level - right.level || right.advantage - left.advantage);
}

async function main() {
  const battles = Math.max(1, integerArgument("battles", 256));
  const startIndex = integerArgument("start-index", 0);
  const shard = integerArgument("shard", 0);
  const shards = Math.max(1, integerArgument("shards", 1));
  const durationMs = Math.max(8_000, integerArgument("duration-ms", 45_000));
  const minimumAdvantage = Math.max(0, numberArgument("minimum-advantage", 2.5));
  const elitePerGroup = Math.max(1, integerArgument("elite-per-group", 2));
  const output = argument("output", `training/reports/v2-pairs/shard-${shard}.json`);
  const pairs = [];
  const baselineOutcomes = {};
  const exploredOutcomes = {};
  const endIndex = startIndex + battles;

  for (let battleIndex = startIndex + shard; battleIndex < endIndex; battleIndex += shards) {
    const relative = battleIndex - startIndex;
    const level = 2 + (relative % 4);
    const script = PLAYER_SCRIPTS[Math.floor(relative / 4) % PLAYER_SCRIPTS.length];
    const coop = relative % 5 === 0;
    const pair = await simulateNeuralV2Pair({battleIndex, durationMs, level, script, coop});
    pairs.push(pair);
    baselineOutcomes[pair.baseline.outcome] = (baselineOutcomes[pair.baseline.outcome] || 0) + 1;
    exploredOutcomes[pair.explored.outcome] = (exploredOutcomes[pair.explored.outcome] || 0) + 1;
  }

  const elitePairs = selectNeuralV2Elites(pairs, elitePerGroup, minimumAdvantage);
  const advantages = pairs.map(pair => pair.advantage);
  const report = {
    format: "echo-neural-v2-pairs-v1",
    generatedAt: new Date().toISOString(),
    requestedPairs: battles,
    completedPairs: pairs.length,
    authoritativeRollouts: pairs.length * 2,
    startIndex,
    endIndex,
    shard,
    shards,
    durationMs,
    minimumAdvantage,
    elitePerGroup,
    positivePairs: pairs.filter(pair => usablePair(pair, minimumAdvantage)).length,
    baselineOutcomes,
    exploredOutcomes,
    advantageRange: {
      minimum: Math.min(...advantages),
      maximum: Math.max(...advantages),
      mean: advantages.reduce((sum, value) => sum + value, 0) / Math.max(1, advantages.length),
    },
    actionSchema: {
      throttle: NEURAL_V2_THROTTLE_CLASSES,
      steering: NEURAL_V2_STEERING_CLASSES,
      range: NEURAL_V2_RANGE_CLASSES,
      route: NEURAL_V2_ROUTE_CLASSES,
      fire: NEURAL_V2_FIRE_CLASSES,
    },
    critique: [
      "The unchanged rollout and v2-macro rollout share one world seed; only the explicit v2 override differs.",
      "The current v2 label is excluded from its own recurrent input fields; those five feature slots are zero in this discovery batch.",
      "Override diagnostics are captured before cleanup, so water clamps and fire suppression contribute to the score and remain auditable.",
      "A full five-head action is held for 0.8 to 2.2 seconds, which is more expressive but makes attribution between heads imperfect.",
      "This batch discovers causal action candidates; it does not yet train or enable a v2 neural model.",
    ],
    elitePairs,
  };
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(report)}\n`);
  console.log(JSON.stringify({
    output,
    completedPairs: pairs.length,
    authoritativeRollouts: pairs.length * 2,
    positivePairs: report.positivePairs,
    elites: elitePairs.length,
    baselineOutcomes,
    exploredOutcomes,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
