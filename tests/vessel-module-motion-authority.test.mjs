import test from "node:test";
import assert from "node:assert/strict";

import {
  finishVesselModuleMotionAuthority,
  prepareVesselModuleMotionAuthority,
} from "../public/src/vessel/vessel-runtime-v3.js?v=1";

function futureModuleBoat(overrides = {}) {
  return {
    id: 7,
    x: 210,
    y: 151,
    heading: 180,
    speed: 36,
    collisionRadius: 6,
    crew: [0],
    driver: 0,
    ...overrides,
  };
}

function futureWorld(overrides = {}) {
  return {
    events: [],
    players: [{mode: "boat", activeBoat: 7, x: 210, y: 151, heading: 180}],
    bounds: {width: 420, height: 320, shoreY: 72},
    ...overrides,
  };
}

const before = Object.freeze({x: 210, y: 150, heading: 180, speed: 52, rudder: 0});

test("shared module-motion authority protects a future speed-only vessel from legacy rollback", () => {
  const world = futureWorld();
  const boat = futureModuleBoat();

  const token = prepareVesselModuleMotionAuthority({world, boat, before, dt: 0.04, eventStart: 0});
  assert.ok(token, "clean module motion must receive the shared authority token");
  assert.equal(boat.speed, 52, "future module must start from the real pre-legacy speed, not legacy 36");

  // This stands in for any future module-driven propulsion implementation. It
  // knows nothing about the legacy bridge and changes only its own final speed.
  boat.speed += 4;
  const rebuilt = finishVesselModuleMotionAuthority({world, boat, token});

  assert.equal(rebuilt, true);
  assert.equal(boat.speed, 56);
  assert.ok(boat.y > before.y, "shared runtime must rebuild clean displacement from the module speed");
  assert.notEqual(boat.y, 151, "stale legacy displacement must not survive a clean module tick");
  assert.equal(world.players[0].x, boat.x);
  assert.equal(world.players[0].y, boat.y);
});

test("shared module-motion authority never overwrites a real collision result", () => {
  const world = futureWorld({events: [{type: "collision", boatId: 7}]});
  const boat = futureModuleBoat({x: 205, y: 155, speed: 10});

  const token = prepareVesselModuleMotionAuthority({world, boat, before, dt: 0.04, eventStart: 0});
  assert.equal(token, null, "collision tick must stay under the resolved contact state");
  assert.equal(boat.speed, 10);
  assert.equal(boat.x, 205);
  assert.equal(boat.y, 155);
});

test("shared module-motion authority preserves a future module that integrates its own position", () => {
  const world = futureWorld();
  const boat = futureModuleBoat();
  const token = prepareVesselModuleMotionAuthority({world, boat, before, dt: 0.04, eventStart: 0});
  assert.ok(token);

  boat.speed = 60;
  boat.x = 220;
  boat.y = 160;
  const rebuilt = finishVesselModuleMotionAuthority({world, boat, token});

  assert.equal(rebuilt, false, "full custom motion must not be integrated a second time by the shared runtime");
  assert.equal(boat.x, 220);
  assert.equal(boat.y, 160);
  assert.equal(boat.speed, 60);
});
