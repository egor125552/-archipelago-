import test from "node:test";
import assert from "node:assert/strict";
import {readdir, readFile} from "node:fs/promises";
import {extname, join} from "node:path";

import {
  createFreeWorld,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {prepareDualTurretBoatRoom} from "../public/src/free-roam-dual-turret-boat.js";
import {DUAL_TURRET_SHOT_DAMAGE} from "../public/src/free-roam-dual-turret-config.js";

function seat(world, playerIndex, boat) {
  setPlayerPresence(world, playerIndex, true);
  const player = world.players[playerIndex];
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  player.combat.alive = true;
  player.combat.health = 100;
  player.combat.equipped = "dual-turret";
}

test("both mounted guns fire from the same controller objects in one server tick", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  for (const other of world.boats) {
    if (!other || other.id === boat.id) continue;
    other.reserved = true;
    other.x = 20 + other.id * 20;
    other.y = 290;
  }
  for (const crate of world.freeActivities.crates) {
    crate.x = 20;
    crate.y = 20;
  }

  boat.x = 210;
  boat.y = 210;
  boat.heading = 0;
  boat.speed = 0;
  boat.driver = 0;
  boat.crew = [0, 1];
  seat(world, 0, boat);
  seat(world, 1, boat);
  stepFreeWorld(world, 0.01);

  const target = world.freeActivities.marauder;
  assert.ok(target);
  target.active = true;
  target.destroyed = false;
  target.hull = 100;
  target.x = boat.x;
  target.y = boat.y - 40;
  world.players[0].combat.lockedTargetId = target.id;
  world.players[1].combat.lockedTargetId = target.id;
  const leftAmmo = boat.turrets[0].ammo;
  const rightAmmo = boat.turrets[1].ammo;

  setPlayerInput(world, 0, {attack: true});
  setPlayerInput(world, 1, {attack: true});
  stepFreeWorld(world, 0.05);

  assert.equal(target.hull, 100 - DUAL_TURRET_SHOT_DAMAGE * 2);
  assert.equal(boat.turrets[0].ammo, leftAmmo - 1);
  assert.equal(boat.turrets[1].ammo, rightAmmo - 1);
  assert.equal(world.freeDualTurretBoat.turrets[0], boat.turrets[0]);
  assert.equal(world.freeDualTurretBoat.turrets[1], boat.turrets[1]);
  assert.equal(world.events.filter(event => event.type === "dual-turret-shot").length, 2);
});

async function JavaScriptFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await JavaScriptFiles(path));
    else if ([".js", ".mjs"].includes(extname(entry.name))) found.push(path);
  }
  return found;
}

test("production source has no imports of removed parallel patrol runtimes", async () => {
  const roots = [
    new URL("../public/src/", import.meta.url),
    new URL("../src/", import.meta.url),
  ];
  const forbidden = [
    "free-roam-player-boats.js",
    "free-roam-dual-turret-test-lifecycle.js",
    "free-roam-dual-turret-purchase.js",
  ];
  for (const root of roots) {
    for (const file of await JavaScriptFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const name of forbidden) {
        assert.equal(source.includes(name), false, `${file} still references ${name}`);
      }
    }
  }
});
