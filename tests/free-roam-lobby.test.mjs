import test from "node:test";
import assert from "node:assert/strict";

import {chooseWaitingRoom, createRoomCode, publicRoomList} from "../src/lobby-core.js";

test("free-roam players never enter operation rooms", () => {
  const socket = {};
  const rooms = new Map([
    ["SEA-OPS", {id: "SEA-OPS", mode: "ops", captain: socket, crew: null, createdAt: 1000}],
    ["FREE-ONE", {id: "FREE-ONE", mode: "free", captain: socket, crew: null, createdAt: 2000}],
  ]);

  assert.equal(chooseWaitingRoom(rooms, "crew", "ops")?.id, "SEA-OPS");
  assert.equal(chooseWaitingRoom(rooms, "crew", "free")?.id, "FREE-ONE");
  assert.deepEqual(publicRoomList(rooms, 5000, "free"), [
    {id: "FREE-ONE", waitingFor: "crew", ageSeconds: 3},
  ]);
});

test("free-roam room codes have a separate readable prefix", () => {
  assert.equal(createRoomCode(new Uint32Array([0, 1, 2, 3, 4]), "FREE"), "FREE-ABCDE");
});
