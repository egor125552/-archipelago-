import test from "node:test";
import assert from "node:assert/strict";

import {
  adoptExistingHeavyForThreatV174,
  restoreHeavyAfterDuplicateSpawnV174,
} from "../public/src/free-roam-combat-ai-model-v174.js";

function baseWorld() {
  const boat = {
    id: "heavy-pursuer",
    role: "heavy",
    x: 283.161,
    y: 186.696,
    heading: 135.11,
    speed: 0,
    hull: 218,
    maxHull: 260,
    engineHealth: 91.69,
    maxEngineHealth: 180,
    turretHealth: 0,
    maxTurretHealth: 240,
    engineDisabled: false,
    turretDisabled: true,
    active: true,
    destroyed: false,
    targetPlayer: 0,
    fireCooldown: 999,
    burstRemaining: 0,
    aimRemaining: 0,
  };
  return {
    time: 6598.4,
    events: [],
    players: [
      {combat: {alive: true}},
      {combat: {alive: true}},
    ],
    freeActivities: {presence: [true, true]},
    freeThreatDirector: {
      active: true,
      level: 5,
      encounterId: 12,
      heavyStarted: false,
      heavyStartsAt: 6598.44,
      assignments: {"heavy-pursuer": 0},
      lastPoint: {x: 90, y: 126},
    },
    freeHeavyPursuer: {
      active: true,
      encounterId: 11,
      boat,
      projectiles: [{id: "old-shot", x: 280, y: 180, ttl: 1}],
      nextProjectileId: 8,
    },
    freeCombatAiV164: {
      heavyEncounterId: 11,
      heavy: {
        encounterId: 11,
        phase: "breach-repairing-v166",
        armourBreached: true,
        repairPlates: 3,
        repairSystem: "turret",
        repairProgress: 4.2,
        repairQuarter: 1,
        destination: {x: 404, y: 308},
        combatPoint: {x: 263, y: 166},
        v167ReachableDestination: {x: 404, y: 308},
        v168SafeDestination: {x: 404, y: 308},
      },
    },
    freeCombatAiV172: {
      repairEncounterId: "11",
      stableRepairDestination: {x: 404, y: 308},
      targetLocks: {},
      lastOutOfRangeFireAt: {},
    },
    freeHostileActors: {active: true, level: 5, actors: [], projectiles: [], nextProjectileId: 1},
  };
}

test("V174 adopts an already active heavy before the delayed level-five respawn", () => {
  const world = baseWorld();
  const originalBoat = world.freeHeavyPursuer.boat;
  const adopted = adoptExistingHeavyForThreatV174(world, 0.06);

  assert.equal(adopted, true);
  assert.equal(world.freeThreatDirector.heavyStarted, true);
  assert.equal(world.freeThreatDirector.heavyStartsAt, 0);
  assert.equal(world.freeHeavyPursuer.boat, originalBoat);
  assert.equal(originalBoat.hull, 218);
  assert.equal(originalBoat.turretHealth, 0);
  assert.equal(originalBoat.x, 283.161);
  assert.equal(originalBoat.y, 186.696);
  assert.equal(world.freeHeavyPursuer.encounterId, 12);
  assert.equal(world.freeCombatAiV164.heavyEncounterId, 12);
  assert.equal(world.freeCombatAiV164.heavy.encounterId, 12);
  assert.equal(world.freeCombatAiV164.heavy.phase, "breach-repairing-v166");
  assert.equal(world.freeCombatAiV164.heavy.repairProgress, 4.2);
  assert.equal(world.freeCombatAiV172.repairEncounterId, "12");
  assert.ok(world.freeHostileActors.actors.some(actor => actor.id === "elite-12" && actor.boatId === "heavy-pursuer"));
  const phaseEvents = world.events.filter(event => event.type === "contract-threat-phase" && event.phase === 2);
  assert.equal(phaseEvents.length, 1);
  assert.equal(phaseEvents[0].continuityV174, true);
  assert.match(phaseEvents[0].text, /без восстановления/);

  assert.equal(adoptExistingHeavyForThreatV174(world, 0.06), false);
  assert.equal(world.events.filter(event => event.type === "contract-threat-phase" && event.phase === 2).length, 1);
});

test("V174 does not start the delayed phase too early", () => {
  const world = baseWorld();
  world.time = 6598.2;
  assert.equal(adoptExistingHeavyForThreatV174(world, 0.06), false);
  assert.equal(world.freeThreatDirector.heavyStarted, false);
  assert.equal(world.freeHostileActors.actors.length, 0);
});

test("V174 restores repair, health and coordinates after a duplicate heavy object replacement", () => {
  const world = baseWorld();
  const oldBoat = world.freeHeavyPursuer.boat;
  const frame = {
    eventStart: 0,
    boatReference: oldBoat,
    boat: {...oldBoat},
    heavy: {
      ...world.freeCombatAiV164.heavy,
      destination: {x: 404, y: 308},
      combatPoint: {x: 263, y: 166},
      v167ReachableDestination: {x: 404, y: 308},
      v168SafeDestination: {x: 404, y: 308},
    },
    pursuerEncounterId: 11,
    projectiles: [{id: "old-shot", x: 280, y: 180, ttl: 1}],
    nextProjectileId: 8,
    repairEncounterId: "11",
    stableRepairDestination: {x: 404, y: 308},
  };

  world.freeHeavyPursuer.encounterId = 12;
  world.freeHeavyPursuer.boat = {
    id: "heavy-pursuer",
    role: "heavy",
    x: 154.02,
    y: 239.028,
    heading: -38,
    speed: 5.5,
    hull: 700,
    maxHull: 700,
    engineHealth: 180,
    maxEngineHealth: 180,
    turretHealth: 240,
    maxTurretHealth: 240,
    active: true,
    destroyed: false,
    targetPlayer: 0,
  };
  world.freeHeavyPursuer.projectiles = [];
  world.freeCombatAiV164.heavyEncounterId = 12;
  world.freeCombatAiV164.heavy = {
    encounterId: 12,
    phase: "combat",
    armourBreached: false,
    repairPlates: 3,
    repairSystem: null,
    repairProgress: 0,
  };
  world.events.push(
    {type: "heavy-pursuer-arrived", text: "reset", x: 154, y: 239},
    {type: "contract-threat-phase", phase: 2, text: "entered"},
    {type: "heavy-tactical-mode-v168", mode: "repair-aborted", text: "aborted"},
  );

  assert.equal(restoreHeavyAfterDuplicateSpawnV174(world, frame), true);
  assert.equal(world.freeHeavyPursuer.boat, oldBoat);
  assert.equal(oldBoat.hull, 218);
  assert.equal(oldBoat.engineHealth, 91.69);
  assert.equal(oldBoat.turretHealth, 0);
  assert.equal(oldBoat.x, 283.161);
  assert.equal(oldBoat.y, 186.696);
  assert.equal(oldBoat.speed, 0);
  assert.equal(world.freeCombatAiV164.heavy.phase, "breach-repairing-v166");
  assert.equal(world.freeCombatAiV164.heavy.repairSystem, "turret");
  assert.equal(world.freeCombatAiV164.heavy.repairProgress, 4.2);
  assert.equal(world.freeCombatAiV164.heavyEncounterId, 12);
  assert.equal(world.freeCombatAiV172.repairEncounterId, "12");
  assert.deepEqual(world.freeCombatAiV172.stableRepairDestination, {x: 404, y: 308});
  assert.deepEqual(world.freeHeavyPursuer.projectiles, [{id: "old-shot", x: 280, y: 180, ttl: 1}]);
  assert.equal(world.events.some(event => event.type === "heavy-pursuer-arrived"), false);
  assert.equal(world.events.some(event => event.type === "heavy-tactical-mode-v168" && event.mode === "repair-aborted"), false);
  assert.match(world.events.find(event => event.type === "contract-threat-phase").text, /без восстановления/);
  assert.ok(world.events.some(event => event.type === "heavy-pursuer-continuity-restored-v174"));
});

test("V174 preserves real movement state instead of a fake nonzero speed at fixed replacement coordinates", () => {
  const world = baseWorld();
  world.freeCombatAiV164.heavy.phase = "breach-escaping-v166";
  world.freeCombatAiV164.heavy.repairProgress = 0;
  world.freeHeavyPursuer.boat.speed = 13.4;
  const oldBoat = world.freeHeavyPursuer.boat;
  const frame = {
    eventStart: 0,
    boatReference: oldBoat,
    boat: {...oldBoat},
    heavy: {...world.freeCombatAiV164.heavy, destination: {x: 404, y: 308}},
    pursuerEncounterId: 11,
    projectiles: [],
    nextProjectileId: 8,
    repairEncounterId: "11",
    stableRepairDestination: {x: 404, y: 308},
  };
  world.freeHeavyPursuer.encounterId = 12;
  world.freeHeavyPursuer.boat = {...oldBoat, x: 154, y: 239, speed: 5.5, hull: 700, engineHealth: 180, turretHealth: 240};
  world.events.push({type: "heavy-pursuer-arrived", text: "reset"});

  assert.equal(restoreHeavyAfterDuplicateSpawnV174(world, frame), true);
  assert.equal(world.freeHeavyPursuer.boat.x, 283.161);
  assert.equal(world.freeHeavyPursuer.boat.y, 186.696);
  assert.equal(world.freeHeavyPursuer.boat.speed, 13.4);
  assert.equal(world.freeCombatAiV164.heavy.phase, "breach-escaping-v166");
  assert.deepEqual(world.freeCombatAiV164.heavy.destination, {x: 404, y: 308});
});

test("hotfix V163 routes authoritative AI through V174", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(
    new URL("../public/src/free-roam-combat-ai-hotfix-v163.js", import.meta.url),
    "utf8",
  ));
  assert.match(source, /free-roam-combat-ai-model-v174\.js\?v=1/);
  assert.match(source, /applyCombatAiModelV174\(world, dt, helpers\)/);
});
