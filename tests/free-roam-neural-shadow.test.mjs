import assert from "node:assert/strict";
import test from "node:test";

import {neuralShadowStatus, updateServerNeuralShadow} from "../src/free-roam-neural-shadow.js";

function fakeServerRoom() {
  return {
    world: {
      time: 12,
      players: [
        {mode: "boat", activeBoat: 0, combat: {alive: true, health: 84}},
        {mode: "dead", activeBoat: 1, combat: {alive: false, health: 0}},
      ],
      boats: [
        {id: 0, owner: 0, driver: 0, x: 200, y: 150, heading: 0, speed: 6, hull: 80, water: 5, leak: 0.3, fuel: 70},
        {id: 1, owner: 1, driver: null, x: -1000, y: -1000, heading: 0, speed: 0, hull: 100, water: 0, leak: 0, fuel: 100},
      ],
      freeActivities: {
        presence: [true, false],
        marauder: {id: "marauder", active: true, destroyed: false, x: 280, y: 210, heading: 250, speed: 8, hull: 62, targetPlayer: 0},
      },
      freePursuerSquad: {escorts: []},
      freeEnemyBoats: {boats: []},
      freeHostileGunners: {gunners: []},
      freeHostileActors: {actors: []},
      freeHeavyPursuer: {active: false, boat: null},
      freeThreatDirector: {level: 4, assignments: {marauder: 0}},
    },
  };
}

test("neural policy observes production-shaped enemies without mutating the world", () => {
  const server = fakeServerRoom();
  const before = JSON.stringify(server.world);
  const status = updateServerNeuralShadow(server, 1_200);
  const after = JSON.stringify(server.world);
  assert.equal(after, before);
  assert.equal(status.controlEnabled, false);
  assert.equal(status.actorCount, 1);
  assert.ok(status.meanMovementConfidence >= 0 && status.meanMovementConfidence <= 1);
  assert.ok(status.meanFireProbability >= 0 && status.meanFireProbability <= 1);
  assert.deepEqual(neuralShadowStatus(server), status);
});
