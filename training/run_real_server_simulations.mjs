import {mkdir, writeFile} from "node:fs/promises";
import process from "node:process";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  startServerTrainingBattle,
  tickServerFreeRoom,
  trainingRuntimeStatus,
} from "../src/free-roam-server.js";
import {collectNeuralActors} from "../src/free-roam-neural-shadow.js";

export const STEP_MS = 40;
export const DEFAULT_DURATION_MS = 24_000;
export const DEFAULT_BATTLES = 256;
export const PLAYER_SCRIPTS = Object.freeze([
  "idle",
  "water-zigzag",
  "water-escape",
  "aggressive",
  "shoreline",
  "damage-control",
]);

function integerArgument(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringArgument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

async function withSeed(seed, callback) {
  const previous = Math.random;
  Math.random = seededRandom(seed);
  try {
    return await callback();
  } finally {
    Math.random = previous;
  }
}

function playerBoat(server, playerIndex) {
  const player = server.world.players?.[playerIndex];
  return server.world.boats?.find(candidate => candidate?.id === player?.activeBoat)
    || server.world.boats?.find(candidate => candidate?.owner === playerIndex)
    || null;
}

function nearestEnemyId(server, playerIndex) {
  const player = server.world.players?.[playerIndex];
  const point = ["boat", "roof"].includes(player?.mode)
    ? playerBoat(server, playerIndex) || player
    : player;
  if (!point) return null;
  const candidates = collectNeuralActors(server.world)
    .filter(actor => actor.controlsMovement !== false && actor.entity?.active !== false && !actor.entity?.destroyed)
    .map(actor => ({
      id: actor.id,
      distance: Math.hypot((Number(actor.entity?.x) || 0) - (Number(point.x) || 0), (Number(actor.entity?.y) || 0) - (Number(point.y) || 0)),
    }))
    .sort((left, right) => left.distance - right.distance);
  return candidates[0]?.id || null;
}

function scriptedInput(script, elapsed, server, playerIndex) {
  const boat = playerBoat(server, playerIndex);
  const player = server.world.players?.[playerIndex];
  const cycle = Math.floor(elapsed / 1800) % 4;
  const targetId = nearestEnemyId(server, playerIndex);
  const input = {
    targetId,
    navigationTargetId: "objective",
    pump: Number(boat?.water) >= 12,
    repair: Number(boat?.leak) >= 1.1 && Math.abs(Number(boat?.speed) || 0) <= 3,
  };

  if (script === "idle") return input;
  if (script === "water-zigzag") {
    return {...input, up: true, left: cycle < 2, right: cycle >= 2};
  }
  if (script === "water-escape") {
    const health = Number(player?.combat?.health) || 0;
    const hull = Number(boat?.hull) || 0;
    return {
      ...input,
      up: true,
      left: cycle === 0 || cycle === 3,
      right: cycle === 1 || cycle === 2,
      attack: health > 35 && hull > 35 && Boolean(targetId),
    };
  }
  if (script === "aggressive") {
    return {
      ...input,
      up: true,
      left: cycle === 1,
      right: cycle === 3,
      attack: Boolean(targetId),
    };
  }
  if (script === "shoreline") {
    const y = Number(boat?.y) || 160;
    return {
      ...input,
      up: y > 92,
      down: y < 84,
      left: cycle === 0,
      right: cycle === 2,
      attack: Boolean(targetId),
    };
  }
  if (script === "damage-control") {
    const damaged = Number(boat?.water) >= 8 || Number(boat?.leak) >= 0.7 || Number(boat?.hull) <= 72;
    return {
      ...input,
      up: !damaged,
      down: damaged && Math.abs(Number(boat?.speed) || 0) > 1,
      left: !damaged && cycle < 2,
      right: !damaged && cycle >= 2,
      attack: !damaged && Boolean(targetId),
      pump: Number(boat?.water) >= 5,
      repair: Number(boat?.leak) >= 0.6 && Math.abs(Number(boat?.speed) || 0) <= 3,
    };
  }
  return input;
}

function activeActorPositions(world) {
  return new Map(collectNeuralActors(world)
    .filter(actor => actor.controlsMovement !== false)
    .map(actor => [actor.id, {x: Number(actor.entity?.x) || 0, y: Number(actor.entity?.y) || 0}]));
}

function invalidWaterActors(world) {
  return collectNeuralActors(world)
    .filter(actor => actor.kind === "boat")
    .filter(actor => {
      const x = Number(actor.entity?.x);
      const y = Number(actor.entity?.y);
      return !Number.isFinite(x) || !Number.isFinite(y) || x < 9.5 || x > 410.5 || y < 81.5 || y > 310.5;
    })
    .map(actor => actor.id);
}

function countEvent(metrics, event) {
  const type = String(event?.type || "");
  metrics.events[type] = (metrics.events[type] || 0) + 1;
  if (type === "heavy-gun-windup") metrics.heavyTurretWindups += 1;
  if (type === "heavy-gun-shot") metrics.heavyTurretShots += 1;
  if (type === "heavy-bullet-boat-hit" || type === "gun-hit") metrics.enemyHits += 1;
  if (type.includes("death") || type.includes("dead")) metrics.deathEvents += 1;
  if (type.includes("victory") || type === "threat-defeated") metrics.victoryEvents += 1;
}

export async function simulateAuthoritativeBattle({
  battleIndex = 0,
  seed = 125_552,
  durationMs = DEFAULT_DURATION_MS,
  level = 2,
  script = "water-zigzag",
  coop = false,
} = {}) {
  return withSeed(seed, async () => {
    const startedAt = 1_000_000 + battleIndex * (durationMs + 10_000);
    const server = createServerFreeRoom(startedAt);
    setServerFreePresence(server, "captain", true);
    if (coop) setServerFreePresence(server, "crew", true);
    startServerTrainingBattle(server, {level, neuralOnly: true}, false, startedAt + STEP_MS);

    const metrics = {
      events: {},
      ticks: 0,
      actorSamples: 0,
      stationaryActorSamples: 0,
      invalidWaterSamples: 0,
      invalidWaterActorIds: new Set(),
      heavyActiveSamples: 0,
      heavyTurretReadySamples: 0,
      heavyTurretWindups: 0,
      heavyTurretShots: 0,
      enemyHits: 0,
      deathEvents: 0,
      victoryEvents: 0,
      neuralControlMissingSamples: 0,
    };
    let previousPositions = activeActorPositions(server.world);
    let captainSequence = 1;
    let crewSequence = 1;

    for (let elapsed = STEP_MS; elapsed <= durationMs; elapsed += STEP_MS) {
      applyServerFreeInput(server, "captain", scriptedInput(script, elapsed, server, 0), captainSequence++);
      if (coop) {
        const crewScript = PLAYER_SCRIPTS[(PLAYER_SCRIPTS.indexOf(script) + 2) % PLAYER_SCRIPTS.length];
        applyServerFreeInput(server, "crew", scriptedInput(crewScript, elapsed + 700, server, 1), crewSequence++);
      }
      const state = tickServerFreeRoom(server, startedAt + STEP_MS + elapsed);
      metrics.ticks += 1;
      for (const event of state.events || []) countEvent(metrics, event);

      const runtime = trainingRuntimeStatus(server);
      if (!runtime.neuralOnly || !runtime.neuralShadow?.controlEnabled) metrics.neuralControlMissingSamples += 1;
      const actors = collectNeuralActors(server.world).filter(actor => actor.controlsMovement !== false);
      metrics.actorSamples += actors.length;
      const nextPositions = new Map();
      for (const actor of actors) {
        const current = {x: Number(actor.entity?.x) || 0, y: Number(actor.entity?.y) || 0};
        const previous = previousPositions.get(actor.id);
        if (previous && Math.hypot(current.x - previous.x, current.y - previous.y) < 0.012) {
          const decision = server.neuralShadowRuntime?.actors?.get(actor.id);
          if (decision?.movement && decision.movement !== "hold") metrics.stationaryActorSamples += 1;
        }
        nextPositions.set(actor.id, current);
      }
      previousPositions = nextPositions;

      const invalid = invalidWaterActors(server.world);
      if (invalid.length) metrics.invalidWaterSamples += 1;
      for (const id of invalid) metrics.invalidWaterActorIds.add(id);

      const heavy = server.world.freeHeavyPursuer?.boat;
      if (heavy?.active && !heavy.destroyed) {
        metrics.heavyActiveSamples += 1;
        if (!heavy.turretDisabled && Number(heavy.turretHealth) > 0) metrics.heavyTurretReadySamples += 1;
      }
    }

    const player = server.world.players?.[0];
    const boat = playerBoat(server, 0);
    const stationaryRatio = metrics.actorSamples ? metrics.stationaryActorSamples / metrics.actorSamples : 0;
    const invalidWaterRatio = metrics.ticks ? metrics.invalidWaterSamples / metrics.ticks : 0;
    const heavyTurretFailed = level === 5
      && metrics.heavyTurretReadySamples >= 20
      && metrics.heavyTurretWindups === 0
      && metrics.heavyTurretShots === 0;

    return {
      battleIndex,
      seed,
      level,
      script,
      coop,
      durationMs,
      ticks: metrics.ticks,
      result: {
        playerHealth: Number(player?.combat?.health) || 0,
        playerAlive: player?.combat?.alive !== false,
        boatHull: Number(boat?.hull) || 0,
        boatWater: Number(boat?.water) || 0,
        boatLeak: Number(boat?.leak) || 0,
        threatActive: Boolean(server.world.freeThreatDirector?.active),
      },
      metrics: {
        ...metrics,
        invalidWaterActorIds: [...metrics.invalidWaterActorIds],
        stationaryRatio,
        invalidWaterRatio,
        heavyTurretFailed,
      },
      failedChecks: [
        ...(metrics.neuralControlMissingSamples ? ["neural-control-missing"] : []),
        ...(metrics.invalidWaterSamples ? ["water-boundary-violation"] : []),
        ...(stationaryRatio > 0.82 ? ["neural-actors-mostly-stationary"] : []),
        ...(heavyTurretFailed ? ["heavy-turret-never-activated"] : []),
      ],
    };
  });
}

export function summarizeBattles(results, requestedBattles = results.length) {
  const byFailure = {};
  const byLevel = {};
  const byScript = {};
  let heavyLevelFiveBattles = 0;
  let heavyTurretFailedBattles = 0;
  let totalStationaryRatio = 0;
  let totalInvalidWaterRatio = 0;
  for (const result of results) {
    byLevel[result.level] ||= {battles: 0, failed: 0};
    byScript[result.script] ||= {battles: 0, failed: 0};
    byLevel[result.level].battles += 1;
    byScript[result.script].battles += 1;
    if (result.failedChecks.length) {
      byLevel[result.level].failed += 1;
      byScript[result.script].failed += 1;
    }
    for (const failure of result.failedChecks) byFailure[failure] = (byFailure[failure] || 0) + 1;
    if (result.level === 5) {
      heavyLevelFiveBattles += 1;
      if (result.metrics.heavyTurretFailed) heavyTurretFailedBattles += 1;
    }
    totalStationaryRatio += result.metrics.stationaryRatio;
    totalInvalidWaterRatio += result.metrics.invalidWaterRatio;
  }
  const completedBattles = results.length;
  const critique = [
    "These battles execute the authoritative server tick and production threat entry point, but they do not include WebSocket latency, Durable Object restarts or browser audio timing.",
    "The players are deterministic scripts rather than humans, so the distribution can expose mechanical failures but cannot prove that combat feels intelligent or fair.",
    "A water safety filter can prevent illegal movement while still hiding a weak neural policy; guardrail interventions must be counted separately from policy quality.",
    "The current generated model was validated on only 1,472 frames. Evaluation at large scale does not itself retrain that model or create new weights.",
    "A million-battle request is a distributed compute target. The report must distinguish requested battles from battles actually completed and must never imply unfinished shards were run.",
  ];
  return {
    format: "echo-authoritative-neural-simulation-v1",
    generatedAt: new Date().toISOString(),
    requestedBattles,
    completedBattles,
    failedBattles: results.filter(result => result.failedChecks.length).length,
    meanStationaryRatio: completedBattles ? totalStationaryRatio / completedBattles : 0,
    meanInvalidWaterRatio: completedBattles ? totalInvalidWaterRatio / completedBattles : 0,
    heavyLevelFiveBattles,
    heavyTurretFailedBattles,
    byFailure,
    byLevel,
    byScript,
    critique,
    verdict: completedBattles > 0
      && !byFailure["neural-control-missing"]
      && !byFailure["water-boundary-violation"]
      && heavyTurretFailedBattles === 0
      ? "mechanically-acceptable-for-more-simulation"
      : "rejected",
  };
}

async function main() {
  const totalBattles = Math.max(1, integerArgument("battles", DEFAULT_BATTLES));
  const shard = integerArgument("shard", 0);
  const shards = Math.max(1, integerArgument("shards", 1));
  const durationMs = Math.max(4_000, integerArgument("duration-ms", DEFAULT_DURATION_MS));
  const output = stringArgument("output", `training/reports/real-server-shard-${shard}.json`);
  const results = [];
  for (let battleIndex = shard; battleIndex < totalBattles; battleIndex += shards) {
    const level = 2 + (battleIndex % 4);
    const script = PLAYER_SCRIPTS[Math.floor(battleIndex / 4) % PLAYER_SCRIPTS.length];
    const coop = battleIndex % 5 === 0;
    const seed = 125_552 + battleIndex * 7_919;
    results.push(await simulateAuthoritativeBattle({battleIndex, seed, durationMs, level, script, coop}));
  }
  const summary = summarizeBattles(results, totalBattles);
  const report = {summary, shard, shards, results};
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    shard,
    shards,
    completedBattles: summary.completedBattles,
    failedBattles: summary.failedBattles,
    verdict: summary.verdict,
  }, null, 2));
  if (summary.verdict === "rejected") process.exitCode = 4;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
