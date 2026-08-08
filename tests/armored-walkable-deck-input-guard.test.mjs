import test from "node:test";
import assert from "node:assert/strict";
import {prepareFreeRoamPlayerInput} from "../public/src/free-roam-core-v8.js";

test("walkable vessel input bypasses the legacy armored seat controller", () => {
  const world = {
    players: [{vesselDeckInputOwned: true}],
    freeDualTurretBoat: {rawActionHeld: [false]},
  };
  const input = {up: false, down: false, left: false, right: false, action: false, attack: false};
  assert.deepEqual(prepareFreeRoamPlayerInput(world, 0, input), input);
});
