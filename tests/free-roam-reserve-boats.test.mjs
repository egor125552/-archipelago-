import test from "node:test";
import assert from "node:assert/strict";

import {
  createServerFreeRoom,
  setServerFreePresence,
} from "../src/free-roam-server.js";

const boatFor = (room, owner) => room.world.boats.find(boat => boat.owner === owner);
const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);

test("an empty server room keeps both player boats outside the playable world", () => {
  const room = createServerFreeRoom(1_000);
  for (const boat of room.world.boats) {
    assert.equal(boat.reserved, true);
    assert.equal(boat.sunk, true);
    assert.equal(boat.driver, null);
    assert.ok(boat.x < 0);
    assert.ok(boat.y < 0);
  }
  assert.equal(room.world.tow, null);
});

test("solo play activates only the connected player's boat", () => {
  const room = createServerFreeRoom(1_000);
  assert.equal(setServerFreePresence(room, "captain", true), true);

  const captainBoat = boatFor(room, 0);
  const crewBoat = boatFor(room, 1);
  assert.equal(captainBoat.reserved, false);
  assert.equal(captainBoat.sunk, false);
  assert.equal(captainBoat.driver, 0);
  assert.equal(room.world.players[0].activeBoat, captainBoat.id);

  assert.equal(crewBoat.reserved, true);
  assert.equal(crewBoat.sunk, true);
  assert.equal(crewBoat.driver, null);
  assert.ok(distance(captainBoat, crewBoat) > 24);
});

test("the second player's boat appears nearby only when that player joins", () => {
  const room = createServerFreeRoom(1_000);
  setServerFreePresence(room, "captain", true);
  setServerFreePresence(room, "crew", true);

  const captainBoat = boatFor(room, 0);
  const crewBoat = boatFor(room, 1);
  assert.equal(crewBoat.reserved, false);
  assert.equal(crewBoat.sunk, false);
  assert.equal(crewBoat.driver, 1);
  assert.equal(room.world.players[1].activeBoat, crewBoat.id);
  assert.ok(distance(captainBoat, crewBoat) <= 24);
});

test("reconnecting keeps the existing boat position and state", () => {
  const room = createServerFreeRoom(1_000);
  setServerFreePresence(room, "captain", true);
  setServerFreePresence(room, "crew", true);

  const crewBoat = boatFor(room, 1);
  crewBoat.x = 301;
  crewBoat.y = 241;
  crewBoat.hull = 47;
  crewBoat.cargo = ["crate-value"];

  setServerFreePresence(room, "crew", false);
  setServerFreePresence(room, "crew", true);

  assert.equal(crewBoat.x, 301);
  assert.equal(crewBoat.y, 241);
  assert.equal(crewBoat.hull, 47);
  assert.deepEqual(crewBoat.cargo, ["crate-value"]);
  assert.equal(crewBoat.reserved, false);
});
