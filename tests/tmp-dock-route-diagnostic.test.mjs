import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {turnBoatToSonar} from "../public/src/free-roam-sonar-guide.js";

const target = {id: "dock", kind: "dock", label: "причал для разгрузки", x: 154, y: 82};
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const input = overrides => ({
  up: false, down: false, left: false, right: false, run: false,
  pump: false, repair: false, action: false, jump: false, attack: false,
  weapon: false, sonar: false, guide: false, targetId: null,
  navigationTargetId: "objective", shopPrevious: false, shopNext: false,
  shopBuy: false, shopClose: false, boardPrevious: false, boardNext: false,
  boardAccept: false, boardClose: false, ...overrides,
});

function createRouteWorld() {
  const world = createFreeWorld();
  setPlayerPresence(world, 1, false);
  const player = world.players[0];
  const boat = world.boats[0];
  Object.assign(boat, {
    x: 119.754,
    y: 275.739,
    heading: -159.908,
    speed: 0,
    throttle: 0,
    rudder: 0,
    hull: 100,
    water: 0,
    leak: 0,
    engineStalled: false,
    emergencyActive: false,
    sunk: false,
  });
  Object.assign(player, {mode: "boat", activeBoat: boat.id, x: boat.x, y: boat.y, heading: boat.heading});
  world.boats[1].x = 390;
  world.boats[1].y = 290;
  world.freeScenario.targets[0] = {...target};
  drainEvents(world);
  return {world, player, boat};
}

function stepFor(world, seconds, nextInput) {
  const events = [];
  const frames = Math.ceil(seconds / 0.05);
  for (let frame = 0; frame < frames; frame += 1) {
    setPlayerInput(world, 0, input(nextInput));
    stepFreeWorld(world, 0.05);
    events.push(...drainEvents(world));
  }
  return events;
}

function boatState(world, boat, player) {
  return {
    time: world.time,
    x: boat.x,
    y: boat.y,
    heading: boat.heading,
    speed: boat.speed,
    hull: boat.hull,
    water: boat.water,
    leak: boat.leak,
    emergencyActive: boat.emergencyActive,
    emergencyRemaining: boat.emergencyRemaining,
    sunk: boat.sunk,
    mode: player.mode,
    distance: distance(boat, target),
  };
}

test("the direct sonar bearing reaches the dock without a collision", () => {
  const {world, player, boat} = createRouteWorld();
  let minimum = distance(boat, target);
  let firstCollision = null;
  const guideHeadings = [];

  for (let frame = 0; frame < 1_600; frame += 1) {
    if (frame % 20 === 0) {
      turnBoatToSonar(world, 0, () => {});
      guideHeadings.push({time: world.time, x: boat.x, y: boat.y, heading: boat.heading, distance: distance(boat, target)});
    }
    const events = stepFor(world, 0.05, {up: true});
    const collision = events.find(event => event.type === "collision");
    if (collision && !firstCollision) firstCollision = {...boatState(world, boat, player), text: collision.text};
    minimum = Math.min(minimum, distance(boat, target));
    if (player.mode !== "boat" || distance(boat, target) <= 8.5) break;
  }

  console.log("DOCK_ROUTE_DIRECT", JSON.stringify({minimum, firstCollision, final: boatState(world, boat, player), guideHeadings}));
  assert.equal(firstCollision, null);
  assert.equal(player.mode, "boat");
  assert.ok(distance(boat, target) <= 8.5);
});

test("the old browser audit overshoots because it brakes only inside 8.5 metres", () => {
  const {world, player, boat} = createRouteWorld();
  const cycles = [];
  const collisions = [];

  for (let cycle = 0; cycle < 70; cycle += 1) {
    const metres = distance(boat, target);
    cycles.push({cycle, before: boatState(world, boat, player)});
    if (metres <= 8.5) {
      stepFor(world, 0.05, {jump: true});
      stepFor(world, 1.3, {});
      break;
    }
    turnBoatToSonar(world, 0, () => {});
    const holdSeconds = metres > 55 ? 0.95 : metres > 25 ? 0.7 : 0.42;
    const events = stepFor(world, holdSeconds, {up: true});
    events.push(...stepFor(world, 0.12, {}));
    for (const event of events.filter(event => ["collision", "flood-emergency-start", "sink"].includes(event.type))) {
      collisions.push({type: event.type, text: event.text, state: boatState(world, boat, player)});
    }
    if (player.mode !== "boat") break;
  }

  console.log("DOCK_ROUTE_OLD_AUDIT", JSON.stringify({cycles, collisions, final: boatState(world, boat, player)}));
  assert.ok(collisions.some(item => item.type === "collision"), "old audit unexpectedly avoided the shore");
  assert.ok(boat.emergencyActive || boat.sunk || player.mode !== "boat", "old audit did not reproduce the destructive overshoot");
});

test("a speed-aware approach reaches and stops at the dock safely", () => {
  const {world, player, boat} = createRouteWorld();
  const cycles = [];
  const collisions = [];

  for (let cycle = 0; cycle < 90; cycle += 1) {
    const metres = distance(boat, target);
    cycles.push({cycle, before: boatState(world, boat, player)});
    if (metres <= 24 || (metres <= 34 && Math.abs(boat.speed) > 10)) {
      stepFor(world, 0.05, {jump: true});
      stepFor(world, 1.3, {});
      if (distance(boat, target) <= 14) break;
    }
    turnBoatToSonar(world, 0, () => {});
    const holdSeconds = metres > 80 ? 0.8 : metres > 45 ? 0.5 : 0.22;
    const events = stepFor(world, holdSeconds, {up: true});
    events.push(...stepFor(world, 0.12, {}));
    collisions.push(...events.filter(event => event.type === "collision"));
    if (player.mode !== "boat") break;
  }

  console.log("DOCK_ROUTE_SAFE_APPROACH", JSON.stringify({cycles, collisionCount: collisions.length, final: boatState(world, boat, player)}));
  assert.equal(collisions.length, 0);
  assert.equal(player.mode, "boat");
  assert.equal(boat.sunk, false);
  assert.equal(boat.emergencyActive, false);
  assert.ok(distance(boat, target) <= 14, `safe approach stopped at ${distance(boat, target).toFixed(1)} m`);
});
