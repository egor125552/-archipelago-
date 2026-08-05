import assert from "node:assert/strict";
import test from "node:test";

import {ensureMegaBombState} from "../src/free-roam-mega-bomb.js";
import {createMegaBombProjectile, stepMegaBombPhysics} from "../src/free-roam-mega-bomb-physics-v1.js";

test("current mega-bomb physics produces a real ballistic arc", () => {
  const projectile = createMegaBombProjectile({
    id: "trajectory-test", owner: 0, start: {x: 210, y: 246.8, z: 2.2},
    heading: 0, intendedDistance: 52, launchSpeed: 48,
  });
  const startZ = projectile.z;
  let highest = startZ;
  let terminal = null;
  for (let index = 0; index < 180 && !terminal; index += 1) {
    const result = stepMegaBombPhysics(projectile, 0.04);
    highest = Math.max(highest, projectile.z);
    if (result.terminal) terminal = result;
  }
  assert.ok(highest > startZ + 2, "the bomb must rise in a ballistic arc");
  assert.ok(projectile.distanceTravelled > 30, "the bomb must travel through the world");
  assert.ok(terminal, "the physical projectile must have a finite ending");
  assert.ok(["water-impact", "ground-impact", "terrain-collision", "boundary-impact", "energy-expired"].includes(terminal.reason));
});

test("legacy saved projectiles are normalized without refilling player stock", () => {
  const world = {
    players: [{combat: {megaBombAmmo: 17, megaBombStock: 17, megaBombCooldown: 0, weapons: {}}}],
    freeMegaBombs: {
      nextId: 2, ammoVersion: 5, projectiles: [{
        id: "mega-bomb-1", owner: 0, x: 10, y: 20, z: 4, vx: 20, vy: -10, age: 0.3, flightTime: 1.3,
      }],
    },
  };
  const state = ensureMegaBombState(world);
  assert.equal(Array.isArray(state.projectiles), true);
  assert.equal(world.players[0].combat.megaBombStock, 17);
  assert.equal(world.players[0].combat.megaBombAmmo, 17);
});
