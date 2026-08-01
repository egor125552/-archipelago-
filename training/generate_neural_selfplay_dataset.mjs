import {mkdir, writeFile} from "node:fs/promises";
import process from "node:process";

import model from "../src/generated/free-roam-tactical-policy-v1.js";
import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  startServerTrainingBattle,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {neuralControlDiagnostics} from "../src/free-roam-neural-control.js";
import {
  collectNeuralActors,
  neuralDecision,
  neuralFeatureVector,
} from "../src/free-roam-neural-shadow.js";

const STEP_MS = 40;
const SAMPLE_MS = Math.max(100, Math.round((Number(model.sampleSeconds) || 0.2) * 1000));
const MOVEMENTS = Object.freeze(model.movementClasses || ["hold", "approach", "retreat", "flank_left", "flank_right"]);
const SCRIPTS = Object.freeze(["idle-no-fire", "water-zigzag", "water-escape", "aggressive", "shoreline", "damage-control"]);

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

export async function withWorldRandomSeed(seed, callback) {
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
  const point = ["boat", "roof"].includes(player?.mode) ? playerBoat(server, playerIndex) || player : player;
  if (!point) return null;
  return collectNeuralActors(server.world)
    .map(actor => ({
      id: actor.id,
      metres: Math.hypot((Number(actor.entity?.x) || 0) - (Number(point.x) || 0), (Number(actor.entity?.y) || 0) - (Number(point.y) || 0)),
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

function roundedFeatures(values) {
  return values.map(value => Math.round((Number(value) || 0) * 100000) / 100000);
}

function chooseDifferentMovement(current, random) {
  if (MOVEMENTS.length <= 1) return current;
  const offset = 1 + Math.floor(random() * (MOVEMENTS.length - 1));
  return (current + offset) % MOVEMENTS.length;
}

export function previousActionFeatureState(previousActions, actorId) {
  const previous = previousActions.get(actorId);
  return previous
    ? {movementIndex: previous.movementIndex, fire: previous.fire}
    : {movementIndex: 0, fire: false};
}

function recordAndExplore(server, trajectories, previousActions, explorationRandom, movementEpsilon, fireEpsilon, elapsedMs) {
  for (const actor of collectNeuralActors(server.world)) {
    const decision = neuralDecision(server, actor.id);
    if (!decision) continue;
    const recurrentState = previousActionFeatureState(previousActions, actor.id);
    const features = roundedFeatures(neuralFeatureVector(server.world, actor, recurrentState));
    const policyMovement = Math.max(0, Math.min(MOVEMENTS.length - 1, Number(decision.movementIndex) || 0));
    const policyFire = Boolean(decision.fire);
    const movementExplored = actor.controlsMovement !== false && explorationRandom() < movementEpsilon;
    const fireExplored = actor.controlsFire !== false && explorationRandom() < fireEpsilon;
    const selectedMovement = movementExplored ? chooseDifferentMovement(policyMovement, explorationRandom) : policyMovement;
    const selectedFire = fireExplored ? !policyFire : policyFire;

    decision.movementIndex = selectedMovement;
    decision.movement = MOVEMENTS[selectedMovement];
    if (actor.controlsFire !== false) {
      decision.fire = selectedFire;
      decision.rawFire = selectedFire;
      if (selectedFire) decision.fireLatch = Math.max(Number(decision.fireLatch) || 0, actor.role === "heavy_turret" ? 12 : 2);
    }
    previousActions.set(actor.id, {movementIndex: selectedMovement, fire: selectedFire});

    let trajectory = trajectories.get(actor.id);
    if (!trajectory) {
      trajectory = {id: actor.id, role: actor.role, kind: actor.kind, samples: []};
      trajectories.set(actor.id, trajectory);
    }
    trajectory.samples.push({
      t: elapsedMs,
      f: features,
      m: selectedMovement,
      fire: Number(selectedFire),
      pm: policyMovement,
      pf: Number(policyFire),
      em: Number(movementExplored),
      ef: Number(fireExplored),
      confidence: Math.round((Number(decision.confidence) || 0) * 10000) / 10000,
      fireProbability: Math.round((Number(decision.fireProbability) || 0) * 10000) / 10000,
    });
  }
}

export function selfPlayScore({outcome, playerHealth, boatHull, boatWater, enemyHits, elapsedMs, durationMs, diagnostics}) {
  const pressure = (100 - playerHealth) * 0.75 + (100 - boatHull) * 0.55 + Math.min(100, boatWater) * 0.3 + enemyHits * 1.8;
  const outcomeScore = outcome === "team-wipe" ? 120 : outcome === "timeout" ? 5 : -45;
  const speedBonus = outcome === "team-wipe" ? Math.max(0, 30 * (1 - elapsedMs / Math.max(1, durationMs))) : 0;
  const guardPenalty = (Number(diagnostics?.waterGuardInterventions) || 0) * 0.02
    + (Number(diagnostics?.stuckEscapes) || 0) * 0.9
    + (Number(diagnostics?.shorelineRedirects) || 0) * 0.008;
  return Math.round((pressure + outcomeScore + speedBonus - guardPenalty) * 1000) / 1000;
}

function hasExploredTrainableTrajectory(episode) {
  return (episode?.actors || []).some(actor => {
    const samples = actor?.samples || [];
    return samples.length >= 4 && samples.some(sample => sample?.em || sample?.ef);
  });
}

export function selectEliteEpisodes(episodes, perScenario = 1, minimumAdvantage = 2.5) {
  const groups = new Map();
  for (const episode of episodes) {
    if (!hasExploredTrainableTrajectory(episode) || Number(episode.advantage) < minimumAdvantage) continue;
    const key = `${Number(episode.level) || 0}:${episode.script || "unknown"}:${episode.coop ? "coop" : "solo"}`;
    const list = groups.get(key) || [];
    list.push(episode);
    groups.set(key, list);
  }
  const selected = [];
  for (const list of groups.values()) {
    list.sort((left, right) => right.advantage - left.advantage || right.score - left.score || left.seed - right.seed);
    selected.push(...list.slice(0, Math.max(1, perScenario)));
  }
  return selected.sort((left, right) => left.level - right.level || String(left.script).localeCompare(String(right.script)) || Number(left.coop) - Number(right.coop) || right.advantage - left.advantage);
}

async function simulateBattle({battleIndex, worldSeed, explorationSeed, durationMs, level, script, coop, movementEpsilon, fireEpsilon, explore}) {
  return withWorldRandomSeed(worldSeed, async () => {
    const explorationRandom = seededRandom(explorationSeed);
    const startedAt = 2_000_000 + battleIndex * (durationMs + 5000);
    const server = createServerFreeRoom(startedAt);
    setServerFreePresence(server, "captain", true);
    if (coop) setServerFreePresence(server, "crew", true);
    startServerTrainingBattle(server, {level, neuralOnly: true}, false, startedAt + STEP_MS);

    const trajectories = new Map();
    const previousActions = new Map();
    let nextSampleAt = 0;
    let enemyHits = 0;
    let elapsedMs = 0;
    let outcome = "timeout";
    let captainSequence = 1;
    let crewSequence = 1;

    for (let elapsed = STEP_MS; elapsed <= durationMs; elapsed += STEP_MS) {
      elapsedMs = elapsed;
      applyServerFreeInput(server, "captain", scriptedInput(script, elapsed, server, 0), captainSequence++);
      if (coop) {
        const crewScript = SCRIPTS[(SCRIPTS.indexOf(script) + 2) % SCRIPTS.length];
        applyServerFreeInput(server, "crew", scriptedInput(crewScript, elapsed + 700, server, 1), crewSequence++);
      }
      const snapshot = tickServerFreeRoom(server, startedAt + STEP_MS + elapsed);
      for (const event of snapshot.events || []) {
        const type = String(event?.type || "");
        if (type === "heavy-bullet-boat-hit" || type === "gun-hit" || type.includes("ram-hit")) enemyHits += 1;
      }
      if (explore && elapsed >= nextSampleAt) {
        recordAndExplore(server, trajectories, previousActions, explorationRandom, movementEpsilon, fireEpsilon, elapsed);
        nextSampleAt = elapsed + SAMPLE_MS;
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

    const captain = server.world.players?.[0];
    const boat = playerBoat(server, 0);
    const diagnostics = neuralControlDiagnostics(server);
    const playerHealth = Math.max(0, Number(captain?.combat?.health) || 0);
    const boatHull = Math.max(0, Number(boat?.hull) || 0);
    const boatWater = Math.max(0, Number(boat?.water) || 0);
    const score = selfPlayScore({outcome, playerHealth, boatHull, boatWater, enemyHits, elapsedMs, durationMs, diagnostics});
    return {
      outcome,
      elapsedMs,
      score,
      playerHealth,
      boatHull,
      boatWater,
      enemyHits,
      diagnostics,
      actors: explore ? [...trajectories.values()].filter(item => item.samples.length >= 4) : [],
    };
  });
}

export async function simulatePairedBattle({battleIndex, durationMs, level, script, coop, movementEpsilon, fireEpsilon}) {
  const worldSeed = 725_552 + battleIndex * 10_007;
  const explorationSeed = 1_925_552 + battleIndex * 65_537;
  const baseline = await simulateBattle({battleIndex, worldSeed, explorationSeed, durationMs, level, script, coop, movementEpsilon: 0, fireEpsilon: 0, explore: false});
  const explored = await simulateBattle({battleIndex, worldSeed, explorationSeed, durationMs, level, script, coop, movementEpsilon, fireEpsilon, explore: true});
  const advantage = Math.round((explored.score - baseline.score) * 1000) / 1000;
  return {
    id: `selfplay-${battleIndex}-${worldSeed}`,
    battleIndex,
    seed: worldSeed,
    explorationSeed,
    level,
    script,
    coop,
    ...explored,
    baseline: {
      outcome: baseline.outcome,
      elapsedMs: baseline.elapsedMs,
      score: baseline.score,
      playerHealth: baseline.playerHealth,
      boatHull: baseline.boatHull,
      boatWater: baseline.boatWater,
      enemyHits: baseline.enemyHits,
      diagnostics: baseline.diagnostics,
    },
    advantage,
  };
}

async function main() {
  const battles = Math.max(1, integerArgument("battles", 256));
  const startIndex = integerArgument("start-index", 0);
  const shard = integerArgument("shard", 0);
  const shards = Math.max(1, integerArgument("shards", 1));
  const durationMs = Math.max(8_000, integerArgument("duration-ms", 45_000));
  const elitePerScenario = Math.max(1, integerArgument("elite-per-scenario", integerArgument("elite-per-level", 1)));
  const minimumAdvantage = Math.max(0, numberArgument("minimum-advantage", 2.5));
  const movementEpsilon = Math.max(0, Math.min(0.7, numberArgument("movement-epsilon", 0.24)));
  const fireEpsilon = Math.max(0, Math.min(0.5, numberArgument("fire-epsilon", 0.10)));
  const output = argument("output", `training/reports/selfplay-shard-${shard}.json`);
  const candidates = [];
  const exploredOutcomeCounts = {};
  const baselineOutcomeCounts = {};
  const endIndex = startIndex + battles;

  for (let battleIndex = startIndex + shard; battleIndex < endIndex; battleIndex += shards) {
    const relative = battleIndex - startIndex;
    const level = 2 + (relative % 4);
    const script = SCRIPTS[Math.floor(relative / 4) % SCRIPTS.length];
    const coop = relative % 5 === 0;
    const episode = await simulatePairedBattle({battleIndex, durationMs, level, script, coop, movementEpsilon, fireEpsilon});
    candidates.push(episode);
    exploredOutcomeCounts[episode.outcome] = (exploredOutcomeCounts[episode.outcome] || 0) + 1;
    baselineOutcomeCounts[episode.baseline.outcome] = (baselineOutcomeCounts[episode.baseline.outcome] || 0) + 1;
  }

  const eliteEpisodes = selectEliteEpisodes(candidates, elitePerScenario, minimumAdvantage);
  const advantages = candidates.map(item => item.advantage);
  const positiveAdvantagePairs = candidates.filter(item => item.advantage >= minimumAdvantage).length;
  const report = {
    format: "echo-neural-selfplay-elites-v2",
    generatedAt: new Date().toISOString(),
    modelVersion: model.version,
    requestedBattles: battles,
    completedBattles: candidates.length,
    authoritativeRollouts: candidates.length * 2,
    startIndex,
    endIndex,
    shard,
    shards,
    durationMs,
    movementEpsilon,
    fireEpsilon,
    minimumAdvantage,
    elitePerScenario,
    baselineOutcomeCounts,
    exploredOutcomeCounts,
    outcomeCounts: exploredOutcomeCounts,
    positiveAdvantagePairs,
    advantageRange: {
      minimum: Math.min(...advantages),
      maximum: Math.max(...advantages),
      mean: advantages.reduce((sum, value) => sum + value, 0) / Math.max(1, advantages.length),
    },
    scoreRange: {
      minimum: Math.min(...candidates.map(item => item.score)),
      maximum: Math.max(...candidates.map(item => item.score)),
    },
    critique: [
      "Each explored rollout is paired with an unmodified rollout using the same world seed; exploration uses a separate random stream and cannot consume production randomness.",
      "Only trajectories whose explored score beats their paired baseline by the configured minimum advantage can enter training.",
      "The score remains a hand-designed proxy for enemy effectiveness and can misvalue tactics; held-out authoritative A/B remains mandatory.",
      "Elite trajectories are retained separately by threat, script and solo/co-op mode so aggregate pressure cannot erase scenario coverage.",
      "Only actions explicitly changed by exploration receive meaningful supervised weight in the fine-tuner; unchanged actions remain context, not claimed discoveries.",
    ],
    eliteEpisodes,
  };
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(report)}\n`);
  console.log(JSON.stringify({
    output,
    completedPairs: candidates.length,
    authoritativeRollouts: candidates.length * 2,
    positiveAdvantagePairs,
    elites: eliteEpisodes.length,
    baselineOutcomeCounts,
    exploredOutcomeCounts,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
