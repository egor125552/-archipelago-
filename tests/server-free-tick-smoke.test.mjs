import test from "node:test";
import assert from "node:assert/strict";
import {createServerFreeRoom, tickServerFreeRoom} from "../src/free-roam-server.js";

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tickSeveral(serverRoom, startAt, count = 6) {
  let snapshot = null;
  for (let index = 1; index <= count; index += 1) {
    snapshot = tickServerFreeRoom(serverRoom, startAt + index * 40);
    assert.ok(snapshot?.world, `tick ${index} did not produce a replicated world`);
    JSON.stringify(snapshot);
  }
  return snapshot;
}

test("production free-roam server keeps producing state across consecutive ticks", () => {
  const startAt = 10_000;
  const serverRoom = createServerFreeRoom(startAt);
  const beforeSequence = serverRoom.sequence;
  const beforeTime = Number(serverRoom.world.time) || 0;
  const snapshot = tickSeveral(serverRoom, startAt);
  assert.ok(serverRoom.sequence >= beforeSequence + 6);
  assert.ok(Number(serverRoom.world.time) > beforeTime, `world time stayed frozen at ${serverRoom.world.time}`);
  assert.equal(snapshot.sequence, serverRoom.sequence);
});

test("restored pre-medium saved world survives its first authoritative tick", () => {
  const startAt = 20_000;
  const source = createServerFreeRoom(startAt);
  const restoredWorld = jsonClone(source.world);

  // Approximate a save created before the medium vessel / authority rollout.
  restoredWorld.boats = (restoredWorld.boats || []).map(boat => boat?.mediumCrewMarker ? null : boat);
  delete restoredWorld.vesselArchitecture;
  for (const boat of restoredWorld.boats || []) {
    if (!boat) continue;
    delete boat.vesselInstanceId;
    delete boat.vesselType;
    delete boat.vesselRuntimeState;
  }

  const serverRoom = {
    world: restoredWorld,
    lastTickAt: startAt,
    sequence: 51_782,
    inputSequence: [0, 0],
    receivedInputs: [{}, {}],
    pendingPulses: [{}, {}],
  };

  const beforeTime = Number(serverRoom.world.time) || 0;
  const snapshot = tickSeveral(serverRoom, startAt, 3);
  assert.ok(Number(serverRoom.world.time) > beforeTime, `restored world time stayed frozen at ${serverRoom.world.time}`);
  assert.ok((serverRoom.world.boats || []).some(boat => boat?.mediumCrewMarker === true), "medium vessel was not restored/spawned");
  assert.ok(snapshot.sequence > 51_782);
});
