import assert from "node:assert/strict";
import test from "node:test";

import {
  createMegaBombProjectile,
  headingVector,
  sourceVelocity,
  stepMegaBombPhysics,
} from "../src/free-roam-mega-bomb-physics-v1.js";

function run(projectile, seconds, dt = 0.04) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    const result = stepMegaBombPhysics(projectile, dt);
    if (result.ricochet || result.terminal) events.push(result);
    if (result.terminal) break;
  }
  return events;
}

test("boat momentum changes real launch velocity", () => {
  const stationary = createMegaBombProjectile({start: {x: 80, y: 220}, heading: 0, intendedDistance: 120});
  const moving = createMegaBombProjectile({
    start: {x: 80, y: 220}, heading: 0, intendedDistance: 120,
    inheritedVelocity: sourceVelocity({heading: 0, speed: 18}),
  });
  const reversing = createMegaBombProjectile({
    start: {x: 80, y: 220}, heading: 0, intendedDistance: 120,
    inheritedVelocity: sourceVelocity({heading: 180, speed: 18}),
  });
  assert.ok(Math.abs(moving.vy) > Math.abs(stationary.vy));
  assert.ok(Math.abs(reversing.vy) < Math.abs(stationary.vy));
});

test("a low shore collision reflects physical velocity and loses energy", () => {
  const projectile = createMegaBombProjectile({start: {x: 110, y: 40, z: 1.9}, heading: 90, intendedDistance: 80});
  projectile.vz = -1;
  const events = run(projectile, 0.5);
  assert.ok(events.some(event => event.reason === "shore-ricochet"));
  assert.ok(projectile.vx < 0);
  assert.ok(projectile.x < 118, "the projectile must remain on the water side after the bounce");
  assert.ok(projectile.energy < 0.7);
});

test("a high projectile crosses the same shore instead of hitting an invisible wall", () => {
  const projectile = createMegaBombProjectile({start: {x: 110, y: 40, z: 8}, heading: 90, intendedDistance: 80});
  projectile.vz = 8;
  const events = run(projectile, 0.5);
  assert.equal(events.some(event => event.reason === "shore-ricochet"), false);
  assert.ok(projectile.x > 118);
});

test("world boundary gives an explicit ricochet or impact instead of deleting the bomb", () => {
  const projectile = createMegaBombProjectile({start: {x: 414, y: 200, z: 2}, heading: 90, intendedDistance: 80});
  projectile.vz = 0;
  const events = run(projectile, 0.4);
  assert.ok(events.some(event => ["boundary-ricochet", "boundary-impact"].includes(event.reason)));
  assert.ok(projectile.x <= 416.1);
});

test("falling into open water reports water impact", () => {
  const projectile = createMegaBombProjectile({start: {x: 80, y: 200, z: 1}, heading: 0, intendedDistance: 30});
  Object.assign(projectile, {vx: 0, vy: 0, vz: -4});
  const events = run(projectile, 1);
  assert.equal(events.at(-1)?.reason, "water-impact");
});

test("heading convention remains north zero and east ninety", () => {
  const north = headingVector(0);
  const east = headingVector(90);
  assert.ok(Math.abs(north.x) < 1e-9 && north.y < -0.99);
  assert.ok(east.x > 0.99 && Math.abs(east.y) < 1e-9);
});
