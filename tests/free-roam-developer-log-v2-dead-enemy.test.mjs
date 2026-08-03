import test from "node:test";
import assert from "node:assert/strict";
import {activeEntitySnapshots} from "../public/src/free-roam-developer-log-model-v2.js";

test("destroyed enemies are not included in repeated entity snapshots", () => {
  const world = {
    players: [], boats: [], freeActivities: {presence: [], marauder: null},
    freePursuerSquad: {escorts: []}, freeEnemyBoats: {boats: [{id: "dead", active: false, destroyed: true}]},
    freeHostileGunners: {gunners: []}, freeHostileActors: {actors: []},
  };
  assert.equal(activeEntitySnapshots(world).some(entity => entity.id === "dead"), false);
});
