import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  enforceHostileRespawnGrace,
  hostileRespawnGraceActive,
} from "../src/free-roam-hostile-respawn-grace.js";

// Architectural guard: no parallel boss AI; grace is a stateless shared safety helper.
test("the obsolete elite tactical side layer no longer exists", () => {
  assert.equal(fs.existsSync(new URL("../src/free-roam-elite-boss-tactics-v12.js", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../src/free-roam-elite-boss-journal-v13.js", import.meta.url)), false);
});

test("shared grace removes hostile projectiles and holds physical actors without tactical state", () => {
  const world = {
    time: 10,
    freeThreatDirector: {graceUntil: [12, 0]},
    freeHostileActors: {
      projectiles: [
        {id: "protected", targetPlayer: 0},
        {id: "other", targetPlayer: 1},
      ],
      actors: [{
        id: "commander",
        active: true,
        destroyed: false,
        targetPlayer: 0,
        aimRemaining: 0.7,
        burstRemaining: 4,
        windupRemaining: 0.3,
        fireCooldown: 0,
        attackCooldown: 0,
        bombCooldown: 0,
        targetLockUntil: 18,
      }],
    },
    freeEliteBoatBoss: {
      projectiles: [
        {id: "elite-protected", targetPlayer: 0},
        {id: "elite-other", targetPlayer: 1},
      ],
      bombRequests: [
        {id: "bomb-protected", targetPlayer: 0},
        {id: "bomb-other", targetPlayer: 1},
      ],
    },
  };

  assert.equal(hostileRespawnGraceActive(world, 0), true);
  assert.equal(hostileRespawnGraceActive(world, 1), false);
  const result = enforceHostileRespawnGrace(world);

  assert.deepEqual(world.freeHostileActors.projectiles.map(item => item.id), ["other"]);
  assert.deepEqual(world.freeEliteBoatBoss.projectiles.map(item => item.id), ["elite-other"]);
  assert.deepEqual(world.freeEliteBoatBoss.bombRequests.map(item => item.id), ["bomb-other"]);
  const actor = world.freeHostileActors.actors[0];
  assert.equal(actor.aimRemaining, 0);
  assert.equal(actor.burstRemaining, 0);
  assert.equal(actor.windupRemaining, 0);
  assert.ok(actor.fireCooldown >= 2);
  assert.ok(actor.attackCooldown >= 2);
  assert.ok(actor.bombCooldown >= 2);
  assert.equal(actor.targetLockUntil, 0);
  assert.deepEqual(result, {removedProjectiles: 2, heldActors: 1, removedBombRequests: 1});
});
