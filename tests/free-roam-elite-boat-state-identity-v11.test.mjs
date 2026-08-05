import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, setPlayerPresence} from "../public/src/free-roam-core-v6.js";
import {
  ELITE_TURRET_HP,
  damageEliteBoatBoss,
  ensureEliteBoatBoss,
  startEliteBoatBoss,
  updateEliteBoatBoss,
} from "../public/src/free-roam-elite-boat.js";

test("valid elite arrays and turret objects keep identity across authoritative ticks", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  setPlayerPresence(world, 0, true);
  world.time = 10;
  const state = startEliteBoatBoss(world, 11, {x: 210, y: 180}, 0);
  state.phase = "boat-combat";
  state.boat.x = 300;
  state.boat.y = 185;
  world.boats[0].x = 190;
  world.boats[0].y = 185;
  world.players[0].mode = "boat";
  world.players[0].activeBoat = world.boats[0].id;

  const armorArray = state.boat.armorLayers;
  const turretArray = state.boat.turrets;
  const port = turretArray.find(turret => turret.side === "port");
  const starboard = turretArray.find(turret => turret.side === "starboard");
  port.fireCooldown = 0.27;
  starboard.fireCooldown = 0.41;

  ensureEliteBoatBoss(world);
  updateEliteBoatBoss(world, 0.04, {});

  assert.equal(state.boat.armorLayers, armorArray);
  assert.equal(state.boat.turrets, turretArray);
  assert.equal(state.boat.turrets[0], port);
  assert.equal(state.boat.turrets[1], starboard);
  assert.ok(port.fireCooldown < 0.27);
  assert.ok(starboard.fireCooldown < 0.41);

  assert.equal(damageEliteBoatBoss(world, "turret-port", ELITE_TURRET_HP, 0, {weapon: "automatic"}), true);
  assert.equal(port.destroyed, true);
  assert.equal(state.boat.turrets.find(turret => turret.side === "port"), port);
  assert.equal(starboard.destroyed, false);
});
