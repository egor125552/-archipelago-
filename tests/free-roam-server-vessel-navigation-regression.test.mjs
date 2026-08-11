import test from "node:test";
import assert from "node:assert/strict";
import {
  applyServerFreeInput,
  createServerFreeRoom,
} from "../src/free-roam-server.js";

test("authoritative server preserves vessel navigation target ids", () => {
  const serverRoom = createServerFreeRoom(1_000);
  const vesselTargetId = "vessel-id:vessel%3Amedium-crew-vessel%3Ai5";

  const accepted = applyServerFreeInput(serverRoom, "captain", {
    navigationTargetId: vesselTargetId,
  }, 1);

  assert.equal(accepted, true);
  assert.equal(serverRoom.receivedInputs[0].navigationTargetId, vesselTargetId);
  assert.equal(serverRoom.world.freeActivities.inputs[0].navigationTargetId, vesselTargetId);
});

test("authoritative server still rejects arbitrary navigation target ids", () => {
  const serverRoom = createServerFreeRoom(1_000);

  applyServerFreeInput(serverRoom, "captain", {
    navigationTargetId: "not-a-real-navigation-target",
  }, 1);

  assert.equal(serverRoom.receivedInputs[0].navigationTargetId, "objective");
  assert.equal(serverRoom.world.freeActivities.inputs[0].navigationTargetId, "objective");
});
