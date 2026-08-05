import test from "node:test";
import assert from "node:assert/strict";
import {
  ELITE_COMMANDER_TACTICAL_SPEED,
  ELITE_TURRET_TACTICAL_SPEED,
  finishEliteBossTacticsV12,
  prepareEliteBossTacticsV12,
} from "../src/free-roam-elite-boss-tactics-v12.js";

function world() {
  return {
    time: 10,
    events: [],
    players: [
      {x: 210, y: 58, heading: 0, mode: "foot", combat: {alive: true, attackCooldown: 1, pistolCooldown: 1, megaBombCooldown: 1}},
      {x: 330, y: 220, heading: 90, mode: "boat", activeBoat: "boat-1", combat: {alive: true}},
    ],
    boats: [{id: "boat-1", x: 330, y: 220, heading: 90, speed: 12}],
    freeActivities: {presence: [true, true]},
    freeThreatDirector: {graceUntil: [12, 0]},
    freeEliteBoatBoss: {
      active: true,
      phase: "boat-combat",
      commanderId: "elite-commander-1",
      bombBayState: "closed",
      bombCooldown: 0,
      bombRequests: [{sourceId: "elite-boat", targetX: 210, targetY: 58}],
      projectiles: [{id: "elite-bullet-1", targetPlayer: 0, x: 200, y: 80, vx: 1, vy: 1}],
      boat: {
        id: "elite-boat", alive: true, x: 210, y: 190, heading: 0, speed: 10,
        turrets: [
          {id: "elite-turret-port", side: "port", destroyed: false},
          {id: "elite-turret-starboard", side: "starboard", destroyed: false},
        ],
      },
    },
    freeHostileActors: {
      actors: [{
        id: "elite-commander-1", commander: true, active: true, destroyed: false,
        targetPlayer: 0, x: 220, y: 58, state: "foot", health: 600, armor: 200,
        aimRemaining: 0.2, burstRemaining: 5, windupRemaining: 0.4,
        fireCooldown: 0, attackCooldown: 0, bombCooldown: 0, weapon: "automatic",
      }],
      projectiles: [{id: "hostile-bullet-1", actorId: "elite-commander-1", targetPlayer: 0, x: 220, y: 58, vx: 1, vy: 1}],
    },
  };
}

test("two-second respawn grace clears hostile ordnance and readies short weapon cooldowns", () => {
  const state = world();
  prepareEliteBossTacticsV12(state, 0.05);
  assert.equal(state.players[0].combat.attackCooldown, 0);
  assert.equal(state.players[0].combat.pistolCooldown, 0);
  assert.equal(state.players[0].combat.megaBombCooldown, 0);
  assert.equal(state.freeEliteBoatBoss.projectiles.length, 0);
  assert.equal(state.freeEliteBoatBoss.bombRequests.length, 0);
  assert.equal(state.freeHostileActors.projectiles.length, 0);
  assert.equal(state.freeHostileActors.actors[0].burstRemaining, 0);
  assert.ok(state.events.some(event => event.type === "elite-respawn-rearm-v12"));
});

test("ready bomb bay starts a physical close bomb run instead of static orbiting", () => {
  const state = world();
  state.freeThreatDirector.graceUntil[0] = 0;
  state.players[0].x = 210;
  state.players[0].y = 58;
  state.freeEliteBoatBoss.boat.x = 210;
  state.freeEliteBoatBoss.boat.y = 180;
  prepareEliteBossTacticsV12(state, 0.05);
  assert.equal(state.freeEliteBossTacticsV12.boatMode, "bomb-run");
  assert.ok(state.freeEliteBoatBoss.boat.speed >= 22.2);
  assert.equal(state.freeEliteBoatBoss.boat.movementMode, "close-bomb-run-v12");
  assert.ok(state.events.some(event => event.type === "elite-bomb-run-v12"));
});

test("new turret and commander bullets receive physical predictive crossfire velocity", () => {
  const state = world();
  state.freeThreatDirector.graceUntil = [0, 0];
  prepareEliteBossTacticsV12(state, 0.05);
  state.freeEliteBoatBoss.projectiles.push({
    id: "elite-bullet-2", turretId: "elite-turret-port", targetPlayer: 1,
    aimSection: "rear", x: 220, y: 170, vx: 1, vy: 1,
  });
  state.freeHostileActors.actors[0].targetPlayer = 1;
  state.freeHostileActors.actors[0].aimRemaining = 0;
  state.freeHostileActors.actors[0].burstRemaining = 5;
  state.freeHostileActors.projectiles.push({
    id: "hostile-bullet-2", actorId: "elite-commander-1", targetPlayer: 1,
    x: 220, y: 160, vx: 1, vy: 1,
  });
  finishEliteBossTacticsV12(state, 0.05);
  const elite = state.freeEliteBoatBoss.projectiles.find(projectile => projectile.id === "elite-bullet-2");
  const commander = state.freeHostileActors.projectiles.find(projectile => projectile.id === "hostile-bullet-2");
  assert.ok(elite.tacticalCrossfireV12);
  assert.ok(Math.abs(Math.hypot(elite.vx, elite.vy) - ELITE_TURRET_TACTICAL_SPEED) < 0.001);
  assert.ok(commander.eliteCommanderLeadV12);
  assert.ok(Math.abs(Math.hypot(commander.vx, commander.vy) - ELITE_COMMANDER_TACTICAL_SPEED) < 0.001);
  assert.equal(state.freeHostileActors.actors[0].burstRemaining, 8);
});
