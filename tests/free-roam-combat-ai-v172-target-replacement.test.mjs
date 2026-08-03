import test from "node:test";
import assert from "node:assert/strict";
import {preserveLongRangeTargetV172} from "../public/src/free-roam-combat-ai-model-v172.js";
import {clearFarTargetReplacementV173} from "../public/src/free-roam-combat-ai-model-v173.js";

test("far selected target does not keep a replacement lock when no replacement was requested", () => {
  const input = {targetId: "heavy-pursuer", attack: false};
  const world = {
    time: 1,
    events: [{type: "target-auto-locked", targets: [0], sourcePlayer: 0}],
    players: [{x: 0, y: 0, mode: "foot", combat: {alive: true, equipped: "automatic", lockedTargetId: "other-enemy", lastTargetRequestId: "heavy-pursuer"}}],
    boats: [],
    freeActivities: {presence: [true], inputs: [input]},
    freeHeavyPursuer: {active: true, boat: {id: "heavy-pursuer", active: true, destroyed: false, x: 360, y: 0, hull: 700, engineHealth: 180, turretHealth: 240, targetPlayer: 0}},
  };
  preserveLongRangeTargetV172(world, {targetLocks: {}, lastOutOfRangeFireAt: {}}, 0);
  clearFarTargetReplacementV173(world);
  assert.equal(world.players[0].combat.lockedTargetId, null);
});
