import assert from "node:assert/strict";
import test from "node:test";

import {
  describeCombatTarget,
  listCombatTargets,
} from "../public/src/free-roam-targeting.js?elite-restored-targets=1";

function worldWithRestoredCollections(turrets) {
  return {
    time: 10,
    players: [{
      id: "player-0",
      x: 0,
      y: 0,
      mode: "foot",
      combat: {alive: true},
    }],
    boats: [],
    freeActivities: {presence: [true], marauder: null},
    freePursuerSquad: {activated: false, escorts: [], assignments: []},
    freeHostileGunners: {gunners: []},
    freeEnemyBoats: {active: false, boats: []},
    freeHostileActors: {active: false, actors: []},
    freeHeavyPursuer: {active: false, boat: null},
    freeEliteBoatBoss: {
      version: "1.0.0",
      active: true,
      encounterId: 7,
      threatEncounterId: 5,
      phase: "boat-combat",
      stage: "armor-outer",
      projectiles: {},
      bombRequests: {},
      boat: {
        id: "elite-boat-5",
        alive: true,
        active: true,
        x: 30,
        y: 0,
        targetPlayer: 0,
        activeArmorIndex: 0,
        armorLayers: {
          0: {id: "outer", hp: 1000, maxHp: 1000, state: "active"},
          1: {id: "middle", hp: 1000, maxHp: 1000, state: "protected"},
          2: {id: "inner", hp: 1000, maxHp: 1000, state: "protected"},
        },
        turrets,
      },
    },
  };
}

test("restored elite boss object collections remain iterable combat targets", () => {
  const world = worldWithRestoredCollections({
    0: {
      id: "elite-turret-port",
      side: "port",
      hp: 520,
      maxHp: 520,
      destroyed: false,
      targetPlayer: 0,
    },
  });

  const targets = listCombatTargets(world, 0);

  assert.ok(Array.isArray(world.freeEliteBoatBoss.boat.armorLayers));
  assert.ok(Array.isArray(world.freeEliteBoatBoss.boat.turrets));
  assert.deepEqual(
    targets.filter(target => target.id.startsWith("elite-")).map(target => target.id).sort(),
    ["elite-armor-outer", "elite-turret-port", "elite-turret-starboard"],
  );
  const turret = targets.find(target => target.id === "elite-turret-port");
  assert.match(describeCombatTarget(turret, 1, 3), /прочность 520/);
});

test("empty restored turret object is repaired into both physical turret targets", () => {
  const world = worldWithRestoredCollections({});

  assert.doesNotThrow(() => listCombatTargets(world, 0));
  assert.deepEqual(
    listCombatTargets(world, 0).filter(target => target.id.startsWith("elite-")).map(target => target.id),
    ["elite-armor-outer", "elite-turret-port", "elite-turret-starboard"],
  );
});
