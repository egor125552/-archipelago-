import test from "node:test";
import assert from "node:assert/strict";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";

function input(overrides = {}) {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    run: false,
    pump: false,
    repair: false,
    action: false,
    jump: false,
    attack: false,
    weapon: false,
    sonar: false,
    guide: false,
    shopPrevious: false,
    shopNext: false,
    shopBuy: false,
    shopClose: false,
    boardPrevious: false,
    boardNext: false,
    boardAccept: false,
    boardClose: false,
    targetId: null,
    navigationTargetId: "objective",
    ...overrides,
  };
}

test("a one-shot weapon command survives true and false before the next server tick", () => {
  const serverRoom = createServerFreeRoom(1_000);
  setServerFreePresence(serverRoom, "captain", true);

  assert.equal(serverRoom.world.players[0].combat.equipped, "fists");
  assert.equal(applyServerFreeInput(serverRoom, "captain", input({weapon: true}), 1), true);
  assert.equal(applyServerFreeInput(serverRoom, "captain", input({weapon: false}), 2), true);
  assert.equal(serverRoom.world.players[0].combat.equipped, "fists");

  const first = tickServerFreeRoom(serverRoom, 1_040);
  assert.equal(serverRoom.world.players[0].combat.equipped, "pistol");
  assert.equal(first.ackInput[0], 2);

  tickServerFreeRoom(serverRoom, 1_080);
  assert.equal(serverRoom.world.players[0].combat.equipped, "pistol");
});

test("continuous movement still uses the newest state instead of being latched", () => {
  const serverRoom = createServerFreeRoom(2_000);
  setServerFreePresence(serverRoom, "captain", true);
  const boat = serverRoom.world.boats[0];

  applyServerFreeInput(serverRoom, "captain", input({up: true}), 1);
  applyServerFreeInput(serverRoom, "captain", input({up: false}), 2);
  tickServerFreeRoom(serverRoom, 2_040);

  assert.equal(boat.throttle, 0);
  assert.ok(Math.abs(boat.speed) < 0.01);
});
