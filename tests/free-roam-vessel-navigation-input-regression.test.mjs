import test from "node:test";
import assert from "node:assert/strict";
import {createFreeWorld} from "../public/src/free-roam-core-v6.js?v=1";
import {storeActivityInput} from "../public/src/free-roam-activities.js?v=44";

test("server keeps vessel navigation targets instead of falling back to objective", () => {
  const world = createFreeWorld();
  const vesselTargetId = "vessel-id:dual-turret-patrol-instance";

  storeActivityInput(world, 0, {navigationTargetId: vesselTargetId});

  assert.equal(world.freeActivities.inputs[0].navigationTargetId, vesselTargetId);
});

test("server keeps all supported non-vessel navigation targets", () => {
  const world = createFreeWorld();

  for (const navigationTargetId of ["objective", "merchant", "board", "vessel:3"]) {
    storeActivityInput(world, 0, {navigationTargetId});
    assert.equal(world.freeActivities.inputs[0].navigationTargetId, navigationTargetId);
  }
});

test("server rejects arbitrary navigation target strings", () => {
  const world = createFreeWorld();

  storeActivityInput(world, 0, {navigationTargetId: "totally-not-a-navigation-target"});

  assert.equal(world.freeActivities.inputs[0].navigationTargetId, "objective");
});
