import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, readdir} from "node:fs/promises";

import {
  createFreeWorld,
  drainEvents,
  setPlayerInput,
  stepFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {CURRENT_VESSEL_TYPES} from "../public/src/vessel/definitions/current-vessels.js";
import {nativeVesselForBoat} from "../public/src/vessel/vessel-runtime.js";
import {STRESS_TEST_PHYSICS_ID, STRESS_TEST_PHYSICS_MODULE} from "../public/src/vessel/physics/stress-test-physics.js";
import {
  STRESS_TEST_AUDIO_PROFILE,
  STRESS_TEST_ENGINE_COUNT,
  STRESS_TEST_ENGINE_URL,
  STRESS_TEST_MAX_SPEED,
  STRESS_TEST_START_AMMO,
  STRESS_TEST_VESSEL_TYPE as TYPE,
} from "../public/src/vessel/stress-test-vessel-config.js";

function stressDefinition() {
  return CURRENT_VESSEL_TYPES.find(definition => definition.id === TYPE);
}

function board(world, boat, playerIndex = 0) {
  const player = world.players[playerIndex];
  const oldBoat = Number.isInteger(player.activeBoat) ? world.boats[player.activeBoat] : null;
  if (oldBoat) {
    if (oldBoat.driver === playerIndex) oldBoat.driver = null;
    if (Array.isArray(oldBoat.crew)) oldBoat.crew = oldBoat.crew.map(value => value === playerIndex ? null : value);
  }
  boat.owner = playerIndex;
  boat.driver = playerIndex;
  boat.crew = [playerIndex];
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
}

test("stress vessel is a registered modular boat with fifty engines and ten thousand rounds", () => {
  const definition = stressDefinition();
  assert.ok(definition);
  assert.equal(definition.physics.mode, "module");
  assert.equal(definition.physics.module, STRESS_TEST_PHYSICS_ID);
  assert.equal(definition.modules.filter(module => module.type === "propulsion").length, STRESS_TEST_ENGINE_COUNT);
  const pistol = definition.modules.find(module => module.id === "stress-pistol");
  assert.equal(pistol.type, "mounted-weapon");
  assert.equal(pistol.config.ammo, STRESS_TEST_START_AMMO);
  assert.equal(pistol.config.interval, 0.04);
  assert.equal(pistol.config.inputMode, "driver-attack");
  assert.equal(definition.runtimeDefaults.audioProfile, STRESS_TEST_AUDIO_PROFILE);
});

test("stress physics derives power from the actual propulsion modules", () => {
  const definition = stressDefinition();
  const instance = {
    modules: Object.fromEntries(definition.modules
      .filter(module => module.type === "propulsion")
      .map(module => [module.id, {enabled: true, health: 100}])),
  };
  const boat = {speed: 0, throttle: 1, sunk: false, reserved: false, engineStalled: false};
  for (let index = 0; index < 30; index += 1) {
    STRESS_TEST_PHYSICS_MODULE.step({boat, definition, instance, dt: 0.04});
  }
  assert.equal(boat.stressEngineCount, 50);
  assert.equal(boat.stressActiveEngineCount, 50);
  assert.equal(boat.speed, STRESS_TEST_MAX_SPEED);

  for (const state of Object.values(instance.modules).slice(10)) state.enabled = false;
  STRESS_TEST_PHYSICS_MODULE.step({boat, definition, instance, dt: 0.1});
  assert.equal(boat.stressActiveEngineCount, 10);
  assert.ok(boat.speed <= STRESS_TEST_MAX_SPEED * 0.2);
});

test("shared vessel runtime spawns one stress boat and its mounted pistol fires server-side without projectiles", () => {
  const world = createFreeWorld();
  stepFreeWorld(world, 0.04);
  let boats = world.boats.filter(boat => boat?.boatType === TYPE);
  assert.equal(boats.length, 1);
  const boat = boats[0];
  assert.equal(boat.audioProfile, STRESS_TEST_AUDIO_PROFILE);
  assert.equal(boat.testWeaponAmmo, STRESS_TEST_START_AMMO);

  stepFreeWorld(world, 0.04);
  boats = world.boats.filter(candidate => candidate?.boatType === TYPE);
  assert.equal(boats.length, 1, "repeated vessel phases must not duplicate the test boat");
  const native = nativeVesselForBoat(world, boat.id);
  assert.ok(native);
  assert.equal(Object.keys(native.instance.modules).filter(id => id.startsWith("engine-")).length, STRESS_TEST_ENGINE_COUNT);

  board(world, boat, 0);
  drainEvents(world);
  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.04);
  const events = drainEvents(world);
  const shot = events.find(event => event.type === "vessel-mounted-shot" && event.boatId === boat.id);
  assert.ok(shot, "mounted pistol should emit a shared server event");
  assert.equal(shot.instant, true);
  assert.equal(shot.weapon, "stress-pistol");
  assert.equal(shot.ammo, STRESS_TEST_START_AMMO - 1);
  assert.equal(boat.testWeaponAmmo, STRESS_TEST_START_AMMO - 1);
  assert.equal(world.freeDualTurretProjectiles, undefined, "stress weapon must not create legacy projectile collections");
});


test("stress engine is one versioned binary WAV with the verified release checksum", async () => {
  assert.equal(STRESS_TEST_ENGINE_URL, "/assets/audio/vessels/stress-50-engine-v1.wav?v=1");
  const url = new URL("../public/assets/audio/vessels/stress-50-engine-v1.wav", import.meta.url);
  const bytes = await readFile(url);
  assert.equal(bytes.byteLength, 1964);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "200c66daf0fbe052c755ae56c6e2c6a4103488d5dc7b4352ae8ec3f0800efd1a");
  const names = await readdir(new URL("../public/assets/audio/vessels/", import.meta.url));
  assert.equal(names.some(name => /(?:\.part-|\.b64$|chunk-)/i.test(name)), false);
});
