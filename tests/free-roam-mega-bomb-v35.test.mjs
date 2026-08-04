import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_SAFE_UNTARGETED_CLEARANCE,
  forwardBoundaryClearanceV35,
  launchMegaBomb,
  untargetedBoundaryRiskV35,
} from "../src/free-roam-mega-bomb-v35.js";

test("north-facing player at y 8.6 is warned instead of receiving an instant ricochet", () => {
  const world = {
    time: 10,
    events: [],
    players: [{
      x: 200,
      y: 8.6,
      heading: 0,
      mode: "foot",
      combat: {
        alive: true,
        knockedDown: false,
        lockedTargetId: null,
        megaBombStock: 12,
        megaBombAmmo: 12,
        megaBombCooldown: 0,
      },
    }],
    boats: [],
    freeActivities: {presence: [true], shopOpen: [false]},
    freeContracts: {boardOpen: [false]},
    freeMegaBombs: {projectiles: [], nextId: 1},
  };

  assert.equal(forwardBoundaryClearanceV35(world.players[0], 0), 4.6);
  assert.ok(untargetedBoundaryRiskV35(world, 0) < MIN_SAFE_UNTARGETED_CLEARANCE);
  assert.equal(launchMegaBomb(world, 0), false);
  assert.equal(world.players[0].combat.megaBombStock, 12);
  assert.equal(world.freeMegaBombs.projectiles.length, 0);
  const denied = world.events.find(event => event.type === "mega-bomb-denied");
  assert.ok(denied);
  assert.equal(denied.boundarySafetyV35, true);
  assert.match(denied.text, /граница мира/);
});

test("an untargeted launch with enough forward water is not blocked by the safety check", () => {
  const world = {
    players: [{x: 200, y: 180, heading: 0, mode: "foot", combat: {lockedTargetId: null}}],
    boats: [],
    freeActivities: {presence: [true]},
  };
  assert.equal(untargetedBoundaryRiskV35(world, 0), null);
});
