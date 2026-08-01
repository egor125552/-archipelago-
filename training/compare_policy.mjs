import {mkdir, writeFile} from "node:fs/promises";
import process from "node:process";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  setServerNeuralControlForTest,
  startServerTrainingBattle,
  tickServerFreeRoom,
  trainingRuntimeStatus,
} from "../src/free-roam-server.js";

const STEP_MS = 40;
const DURATION_MS = 20_000;
const THREATS = [2, 3, 4, 5];
const SCRIPTS = ["idle", "circle"];

function seededRandom(seed) {
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

function playerInput(script, elapsed, server) {
  if (script === "idle") return {};
  const phase = Math.floor(elapsed / 3_000) % 2;
  const boat = server.world.boats?.[0];
  return {
    up: true,
    left: phase === 0,
    right: phase === 1,
    pump: Number(boat?.water) > 20,
    repair: Number(boat?.leak) > 1.2 && Math.abs(Number(boat?.speed) || 0) < 2,
  };
}

function actorBounds(world) {
  const entities = [
    world.freeActivities?.marauder,
    ...(world.freePursuerSquad?.escorts || []),
    ...(world.freeEnemyBoats?.boats || []),
    world.freeHeavyPursuer?.boat,
    ...(world.freeHostileGunners?.gunners || []),
    ...(world.freeHostileActors?.actors || []),
  ].filter(Boolean);
  const invalid = entities.filter(entity => {
    const x = Number(entity.x);
    const y = Number(entity.y);
    return !Number.isFinite(x) || !Number.isFinite(y) || x < -1 || x > 421 || y < -1 || y > 321;
  });
  return {actorCount: entities.length, invalidActorIds: invalid.map(entity => entity.id || "unknown")};
}

function snapshot(server, deaths, eventCount) {
  const player = server.world.players?.[0];
  const boat = server.world.boats?.find(candidate => candidate.owner === 0) || server.world.boats?.[0];
  const health = Math.max(0, Number(player?.combat?.health) || 0);
  const hull = Math.max(0, Number(boat?.hull) || 0);
  const water = Math.max(0, Number(boat?.water) || 0);
  const pressure = deaths * 120 + (100 - health) + (100 - hull) * 0.7 + water * 0.35;
  return {
    deaths,
    eventCount,
    health,
    hull,
    water,
    leak: Number(boat?.leak) || 0,
    pressure,
    bounds: actorBounds(server.world),
    neural: trainingRuntimeStatus(server).neuralShadow,
  };
}

async function simulate({level, script, neural, seed}) {
  return withSeed(seed, async () => {
    const startedAt = 10_000;
    const server = createServerFreeRoom(startedAt);
    setServerFreePresence(server, "captain", true);
    startServerTrainingBattle(server, level, false, startedAt + STEP_MS);
    if (neural) setServerNeuralControlForTest(server, true);
    let deaths = 0;
    let eventCount = 0;
    let sequence = 1;
    for (let elapsed = STEP_MS; elapsed <= DURATION_MS; elapsed += STEP_MS) {
      applyServerFreeInput(server, "captain", playerInput(script, elapsed, server), sequence++);
      const state = tickServerFreeRoom(server, startedAt + STEP_MS + elapsed);
      for (const event of state.events || []) {
        eventCount += 1;
        const type = String(event?.type || "").toLowerCase();
        if ((type.includes("death") || type.includes("dead")) && (event.targets || []).includes(0)) deaths += 1;
      }
    }
    return snapshot(server, deaths, eventCount);
  });
}

async function main() {
  const comparisons = [];
  let safetyFailures = 0;
  let changedScenarios = 0;
  for (const level of THREATS) {
    for (const script of SCRIPTS) {
      const seed = 125_552 + level * 100 + SCRIPTS.indexOf(script);
      const legacy = await simulate({level, script, neural: false, seed});
      const neural = await simulate({level, script, neural: true, seed});
      const changed = Math.abs(neural.pressure - legacy.pressure) > 0.01
        || Math.abs(neural.hull - legacy.hull) > 0.01
        || neural.deaths !== legacy.deaths;
      if (changed) changedScenarios += 1;
      const invalid = neural.bounds.invalidActorIds.length;
      if (invalid || !neural.neural.controlEnabled || neural.neural.actorCount <= 0) safetyFailures += 1;
      comparisons.push({
        level,
        script,
        seed,
        legacy,
        neural,
        changed,
        pressureRatio: legacy.pressure > 0 ? neural.pressure / legacy.pressure : null,
      });
    }
  }

  const report = {
    format: "echo-neural-policy-ab-v1",
    generatedAt: new Date().toISOString(),
    durationSeconds: DURATION_MS / 1000,
    stepMilliseconds: STEP_MS,
    scenarios: comparisons.length,
    changedScenarios,
    safetyFailures,
    controlPromotionAllowed: false,
    verdict: safetyFailures === 0 && changedScenarios > 0 ? "safe-for-further-ab" : "rejected",
    critique: [
      "This harness measures deterministic pressure and bounds, not player enjoyment or final combat superiority.",
      "The controller still relies on production target assignment, damage, collision and firing subsystems.",
      "A control promotion requires longer seeded matches with active scripted fire and fairness limits.",
    ],
    comparisons,
  };
  await mkdir("training/reports", {recursive: true});
  await writeFile("training/reports/latest-ab.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({verdict: report.verdict, safetyFailures, changedScenarios}, null, 2));
  if (report.verdict === "rejected") process.exitCode = 4;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
