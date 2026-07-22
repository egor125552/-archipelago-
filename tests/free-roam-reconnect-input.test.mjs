import test from "node:test";
import assert from "node:assert/strict";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
} from "../src/free-roam-server.js";

test("a page reload can start input numbering from one in the same free-roam world", () => {
  const room = createServerFreeRoom(0);

  setServerFreePresence(room, "crew", true);
  assert.equal(applyServerFreeInput(room, "crew", {up: true}, 300), true);
  assert.equal(room.inputSequence[1], 300);

  // A lower number is still correctly rejected inside the same WebSocket
  // session, so delayed or duplicated commands cannot move the player.
  assert.equal(applyServerFreeInput(room, "crew", {down: true}, 1), false);
  assert.equal(room.world.inputs[1].up, true);
  assert.equal(room.world.inputs[1].down, false);

  // Closing and reopening the role represents a new page/WebSocket session.
  // The room and character survive, but the client's JavaScript counter is
  // allowed to begin from one again.
  setServerFreePresence(room, "crew", false);
  setServerFreePresence(room, "crew", true);
  assert.equal(room.inputSequence[1], 0);
  assert.equal(applyServerFreeInput(room, "crew", {down: true}, 1), true);
  assert.equal(room.inputSequence[1], 1);
  assert.equal(room.world.inputs[1].up, false);
  assert.equal(room.world.inputs[1].down, true);
});

test("sequence protection remains isolated to each connection and each player", () => {
  const room = createServerFreeRoom(0);

  for (let reconnect = 0; reconnect < 500; reconnect += 1) {
    const role = reconnect % 2 === 0 ? "captain" : "crew";
    const playerIndex = role === "captain" ? 0 : 1;
    const firstSequence = reconnect % 3 === 0 ? 1 : 10_000 + reconnect;

    setServerFreePresence(room, role, true);
    assert.equal(room.inputSequence[playerIndex], 0);
    assert.equal(applyServerFreeInput(room, role, {left: true}, firstSequence), true);
    assert.equal(applyServerFreeInput(room, role, {right: true}, firstSequence), false);
    assert.equal(room.world.inputs[playerIndex].left, true);
    assert.equal(room.world.inputs[playerIndex].right, false);
    setServerFreePresence(room, role, false);
  }
});
