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

test("diagnose direct sonar route from automatic crate to dock", () => {
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
  drainEvents(world);

  let minimum = distance(boat, target);
  let firstCollision = null;
  let leftBoat = null;
  const guideHeadings = [];
  for (let frame = 0; frame < 1_600; frame += 1) {
    if (frame % 20 === 0) {
      world.freeScenario.targets[0] = {...target};
      turnBoatToSonar(world, 0, () => {});
      guideHeadings.push({time: world.time, x: boat.x, y: boat.y, heading: boat.heading, distance: distance(boat, target)});
    }
    setPlayerInput(world, 0, input({up: true}));
    stepFreeWorld(world, 0.05);
    const events = drainEvents(world);
    const collision = events.find(event => event.type === "collision");
    if (collision && !firstCollision) {
      firstCollision = {time: world.time, x: boat.x, y: boat.y, heading: boat.heading, speed: boat.speed, hull: boat.hull, water: boat.water, distance: distance(boat, target), text: collision.text};
    }
    minimum = Math.min(minimum, distance(boat, target));
    if (player.mode !== "boat") {
      leftBoat = {time: world.time, mode: player.mode, x: boat.x, y: boat.y, hull: boat.hull, water: boat.water, leak: boat.leak, emergencyRemaining: boat.emergencyRemaining, sunk: boat.sunk, distance: distance(boat, target), events};
      break;
    }
    if (distance(boat, target) <= 8.5) break;
  }

  console.log("DOCK_ROUTE_DIAGNOSTIC", JSON.stringify({minimum, firstCollision, leftBoat, final: {time: world.time, x: boat.x, y: boat.y, heading: boat.heading, speed: boat.speed, hull: boat.hull, water: boat.water, leak: boat.leak, emergencyRemaining: boat.emergencyRemaining, sunk: boat.sunk, mode: player.mode, distance: distance(boat, target)}, guideHeadings}));
  assert.equal(player.mode, "boat");
  assert.ok(distance(boat, target) <= 8.5, `direct route failed at ${distance(boat, target).toFixed(1)} m`);
});
