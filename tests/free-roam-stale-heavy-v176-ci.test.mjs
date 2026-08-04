import test from "node:test";
import assert from "node:assert/strict";
import {retireStaleHeavyV176} from "../public/src/free-roam-combat-ai-model-v176.js";

test("journal identity is recorded when encounter 12 is retired before encounter 13", () => {
  const world = {
    time: 7335.4,
    events: [],
    players: [{combat: {alive: true}}],
    freeActivities: {presence: [true]},
    freeThreatDirector: {
      active: true,
      level: 5,
      encounterId: 13,
      heavyStarted: false,
      heavyStartsAt: 7342.4,
      assignments: {"heavy-pursuer": 0},
    },
    freeHeavyPursuer: {
      active: true,
      encounterId: 12,
      boat: {
        id: "heavy-pursuer",
        active: true,
        destroyed: false,
        hull: 218,
        engineHealth: 0,
        turretHealth: 0,
        x: 205.025,
        y: 118.554,
      },
      projectiles: [],
    },
    freeCombatAiV164: {
      heavyEncounterId: 12,
      heavy: {encounterId: 12, phase: "breach-repairing-v166"},
    },
    freeCombatAiV172: {repairEncounterId: "12"},
    freeHostileActors: {actors: []},
  };

  assert.equal(retireStaleHeavyV176(world), true);
  const event = world.events.find(item => item.type === "heavy-stale-state-retired-v176");
  assert.ok(event);
  assert.deepEqual(event.oldEncounterIds, ["12", "12", "12", "12"]);
  assert.equal(event.encounterId, 13);
  assert.equal(event.hull, 218);
});
