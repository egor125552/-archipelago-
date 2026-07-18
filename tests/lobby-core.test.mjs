import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseAnyWaitingRoom,
  chooseWaitingRoom,
  createRoomCode,
  missingRole,
  oppositeRole,
  publicRoomList,
} from "../src/lobby-core.js";

test("captain and crew are matched into the oldest compatible room", () => {
  const crewSocket = {name: "crew"};
  const captainSocket = {name: "captain"};
  const rooms = new Map([
    ["SEA-LATE", {id: "SEA-LATE", captain: null, crew: crewSocket, createdAt: 2000}],
    ["SEA-EARLY", {id: "SEA-EARLY", captain: null, crew: crewSocket, createdAt: 1000}],
    ["SEA-FULL", {id: "SEA-FULL", captain: captainSocket, crew: crewSocket, createdAt: 500}],
  ]);

  assert.equal(chooseWaitingRoom(rooms, "captain")?.id, "SEA-EARLY");
  assert.equal(chooseWaitingRoom(rooms, "crew"), null);
  assert.equal(oppositeRole("captain"), "crew");
  assert.equal(oppositeRole("crew"), "captain");
});

test("automatic entry fills whichever role is actually missing", () => {
  const socket = {};
  const rooms = new Map([
    ["FREE-OLD", {id: "FREE-OLD", mode: "free", captain: null, crew: socket, createdAt: 1000}],
    ["FREE-NEW", {id: "FREE-NEW", mode: "free", captain: socket, crew: null, createdAt: 2000}],
    ["SEA-OPS", {id: "SEA-OPS", mode: "ops", captain: socket, crew: null, createdAt: 500}],
  ]);

  const selected = chooseAnyWaitingRoom(rooms, "free");
  assert.equal(selected.id, "FREE-OLD");
  assert.equal(missingRole(selected), "captain");
  assert.equal(missingRole(rooms.get("FREE-NEW")), "crew");
  assert.equal(chooseAnyWaitingRoom(new Map(), "free"), null);
});

test("room list contains only rooms waiting for the opposite player", () => {
  const socket = {};
  const rooms = new Map([
    ["SEA-CAP", {id: "SEA-CAP", captain: socket, crew: null, createdAt: 1000}],
    ["SEA-CREW", {id: "SEA-CREW", captain: null, crew: socket, createdAt: 2000}],
    ["SEA-FULL", {id: "SEA-FULL", captain: socket, crew: socket, createdAt: 3000}],
  ]);

  assert.deepEqual(publicRoomList(rooms, 6000), [
    {id: "SEA-CAP", waitingFor: "crew", ageSeconds: 5},
    {id: "SEA-CREW", waitingFor: "captain", ageSeconds: 4},
  ]);
});

test("generated room codes are readable and deterministic in tests", () => {
  assert.equal(createRoomCode(new Uint32Array([0, 1, 2, 3, 4])), "SEA-ABCDE");
});
