import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureMegaBombState,
  megaBombTrajectoryPoint,
} from "../src/free-roam-mega-bomb.js";

test("curved trajectory leaves the launcher direction and still ends exactly on target", () => {
  const projectile = {
    startX: 210,
    startY: 246.8,
    targetX: 210,
    targetY: 195,
    controlX: 219,
    controlY: 220.9,
    arcHeight: 17,
    arcSkew: 0.94,
    flightTime: 1.1,
  };
  const start = megaBombTrajectoryPoint(projectile, 0);
  const middle = megaBombTrajectoryPoint(projectile, 0.5);
  const end = megaBombTrajectoryPoint(projectile, 1);
  assert.equal(start.x, projectile.startX);
  assert.equal(start.y, projectile.startY);
  assert.ok(middle.x > 214, "the bomb must visibly curve sideways");
  assert.ok(middle.z > 15, "the bomb must rise in a ballistic arc");
  assert.ok(Math.abs(end.x - projectile.targetX) < 1e-9);
  assert.ok(Math.abs(end.y - projectile.targetY) < 1e-9);
  assert.ok(Math.abs(end.z - 1.6) < 1e-9);
});

test("legacy straight projectiles receive a safe trajectory when a world is restored", () => {
  const world = {
    players: [{combat: {megaBombAmmo: 82, megaBombCooldown: 0, weapons: {}}}],
    freeMegaBombs: {
      nextId: 2,
      ammoVersion: 3,
      projectiles: [{
        id: "mega-bomb-1",
        owner: 0,
        x: 10,
        y: 20,
        z: 4,
        vx: 20,
        vy: -10,
        age: 0.3,
        flightTime: 1.3,
      }],
    },
  };
  const state = ensureMegaBombState(world);
  const projectile = state.projectiles[0];
  for (const key of ["startX", "startY", "targetX", "targetY", "controlX", "controlY"]) {
    assert.ok(Number.isFinite(projectile[key]), `${key} must be restored`);
  }
  assert.equal(world.players[0].combat.megaBombAmmo, 82);
});
