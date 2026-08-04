import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  prepareCombatAiV164,
  finishCombatAiV164,
  normalizeLegacyHeavyRepair,
} from "../public/src/free-roam-combat-ai-model-v164.js";

function makeWorld() {
  return {
    time: 100,
    events: [],
    players: [{mode: "foot", x: 200, y: 200, combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeThreatDirector: {encounterId: 7},
    freeHeavyPursuer: {
      active: true,
      encounterId: 7,
      boat: {
        id: "heavy-pursuer",
        role: "heavy",
        active: true,
        destroyed: false,
        x: 40,
        y: 110,
        heading: 0,
        speed: 12.2,
        hull: 700,
        maxHull: 700,
        engineHealth: 140,
        maxEngineHealth: 140,
        turretHealth: 0,
        maxTurretHealth: 240,
        turretDisabled: true,
        engineDisabled: false,
      },
      projectiles: [],
    },
    freeHostileActors: {actors: [], projectiles: []},
    freeHostileGunners: {gunners: [], projectiles: []},
    freeEnemyBoats: {boats: [], projectiles: []},
    freePursuerSquad: {escorts: [], projectiles: [], assignments: {}},
  };
}

test("V164 no longer contains the parallel heavy repair implementation", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v164.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /function startHeavyRepair/);
  assert.doesNotMatch(source, /heavy-repair-retreat/);
  assert.doesNotMatch(source, /heavy\.phase === "retreating"/);
  assert.doesNotMatch(source, /heavy\.phase === "repairing"/);
  assert.doesNotMatch(source, /heavy\.phase === "returning"/);
});

test("an old saved retreat is reset for adoption by the unified V166+ lifecycle", () => {
  const heavy = {
    phase: "retreating",
    repairSystem: "turret",
    repairProgress: 5,
    repairQuarter: 1,
    destination: {x: 32, y: 112},
  };
  assert.equal(normalizeLegacyHeavyRepair(heavy), true);
  assert.equal(heavy.phase, "combat");
  assert.equal(heavy.destination, null);
  assert.equal(heavy.repairProgress, 0);
  assert.equal(heavy.repairSystem, "turret");
});

test("destroying a pre-breach turret cannot start the deleted V164 retreat", () => {
  const world = makeWorld();
  prepareCombatAiV164(world);
  finishCombatAiV164(world, 0.2);
  assert.equal(world.freeCombatAiV164.heavy.phase, "combat");
  assert.equal(world.freeCombatAiV164.heavy.actualTurretDisabled, true);
  assert.equal(world.events.some(event => String(event.type).startsWith("heavy-repair-")), false);
});
