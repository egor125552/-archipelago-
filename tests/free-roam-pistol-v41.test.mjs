import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v6.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication.js";
import {COMBAT_TUNING} from "../public/src/free-roam-combat-tuning.js";
import {PISTOL_START_AMMO} from "../public/src/free-roam-combat-v2.js";

function run(world, seconds, dt = 0.02) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    stepFreeWorld(world, dt);
    events.push(...drainEvents(world));
  }
  return events;
}

function tap(world, playerIndex, control) {
  setPlayerInput(world, playerIndex, {[control]: true});
  const events = run(world, 0.04);
  setPlayerInput(world, playerIndex, {[control]: false});
  events.push(...run(world, 0.04));
  return events;
}

function putPlayersOnShore(world, metres = 10) {
  setPlayerPresence(world, 1, true);
  Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 120, y: 45, heading: 90});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 120 + metres, y: 45, heading: 270});
}

test("every player starts with a pistol and a separate magazine reserve", () => {
  const world = createFreeWorld();
  for (const player of world.players) {
    assert.equal(player.combat.weapons.pistol, true);
    assert.equal(player.combat.pistolAmmo, PISTOL_START_AMMO);
    assert.equal(player.combat.ammo, 0);
  }
});

test("Z selects the starting pistol without changing the automatic ammunition type", () => {
  const world = createFreeWorld();
  const combat = world.players[0].combat;
  combat.weapons.automatic = true;
  combat.ammo = 100;

  tap(world, 0, "weapon");
  assert.equal(combat.equipped, "pistol");
  tap(world, 0, "weapon");
  assert.equal(combat.equipped, "automatic");
  assert.equal(combat.pistolAmmo, PISTOL_START_AMMO);
  assert.equal(combat.ammo, 100);
});

test("the pistol uses automatic-style hold fire but shoots slower and for less damage", () => {
  const world = createFreeWorld();
  putPlayersOnShore(world);
  tap(world, 0, "weapon");
  assert.equal(world.players[0].combat.equipped, "pistol");

  setPlayerInput(world, 0, {attack: true});
  const firstEvents = run(world, 0.06);
  assert.equal(world.players[0].combat.pistolAmmo, PISTOL_START_AMMO - 1);
  assert.equal(world.players[1].combat.health, 100 - COMBAT_TUNING.pistolDamage);
  assert.ok(firstEvents.some(event => event.type === "gun-shot" && event.weapon === "pistol"));

  run(world, 0.2);
  assert.equal(world.players[0].combat.pistolAmmo, PISTOL_START_AMMO - 1);
  run(world, 0.16);
  assert.equal(world.players[0].combat.pistolAmmo, PISTOL_START_AMMO - 2);
  assert.equal(world.players[1].combat.health, 100 - COMBAT_TUNING.pistolDamage * 2);

  setPlayerInput(world, 0, {attack: false});
  run(world, 0.04);
  assert.ok(COMBAT_TUNING.pistolDamage < COMBAT_TUNING.automaticDamage);
  assert.ok(COMBAT_TUNING.pistolShotInterval > COMBAT_TUNING.automaticShotInterval);
});

test("pistol ammunition is included in the authoritative replicated world", () => {
  const world = createFreeWorld();
  world.players[0].combat.pistolAmmo = 17;
  const replicated = replicatedFreeWorld(world);
  assert.equal(replicated.players[0].combat.pistolAmmo, 17);
  assert.equal(replicated.players[0].combat.weapons.pistol, true);
});

test("the production page loads the pistol sound and pistol integration modules", async () => {
  const [html, targetMenu, audioPatch, uiPatch] = await Promise.all([
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-target-menu.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-pistol-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-pistol-ui.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /free-roam-pistol-audio\.js\?v=3/);
  assert.match(html, /free-roam-pistol-ui\.js\?v=1/);
  assert.match(html, /36 отдельных пистолетных патронов/);
  assert.match(targetMenu, /combat\?\.weapons\?\.pistol/);
  assert.match(audioPatch, /PISTOL_RECORDING_URL/);
  assert.match(audioPatch, /163456__lemudcrab__pistol-shot\.wav/);
  assert.match(audioPatch, /createFallbackPistolBuffer/);
  assert.match(audioPatch, /buffers\.set\("pistolShot"/);
  assert.match(uiPatch, /pistol: "пистолет"/);
  assert.match(uiPatch, /Оружие: \${label}/);
});
