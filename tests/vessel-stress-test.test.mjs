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
import {setVesselOccupantPosition} from "../public/src/vessel/vessel-interior.js";
// Match the exact runtime identity used by free-roam-core-v8.js. Query-string
// variants are distinct ESM modules and must not own separate vessel WeakMaps.
import {nativeVesselForBoat} from "../public/src/vessel/vessel-runtime.js?v=2";
import {STRESS_TEST_PHYSICS_ID, STRESS_TEST_PHYSICS_MODULE} from "../public/src/vessel/physics/stress-test-physics.js";
import {
  STRESS_TEST_AUDIO_PROFILE,
  STRESS_TEST_ENGINE_COUNT,
  STRESS_TEST_ENGINE_LOOP_SECONDS,
  STRESS_TEST_ENGINE_URL,
  STRESS_TEST_MAX_SPEED,
  STRESS_TEST_START_AMMO,
  STRESS_TEST_VESSEL_TYPE as TYPE,
} from "../public/src/vessel/stress-test-vessel-config.js";

function stressDefinition() {
  return CURRENT_VESSEL_TYPES.find(definition => definition.id === TYPE);
}

function removeFromOldBoat(world, playerIndex) {
  const player = world.players[playerIndex];
  const oldBoat = Number.isInteger(player.activeBoat) ? world.boats[player.activeBoat] : null;
  if (!oldBoat) return;
  if (oldBoat.driver === playerIndex) oldBoat.driver = null;
  if (Array.isArray(oldBoat.crew)) oldBoat.crew = oldBoat.crew.map(value => value === playerIndex ? null : value);
}

function placeOnDeck(world, boat, playerIndex, position) {
  const player = world.players[playerIndex];
  removeFromOldBoat(world, playerIndex);
  boat.crew ||= [];
  if (!boat.crew.includes(playerIndex)) {
    const empty = boat.crew.findIndex(value => value == null);
    if (empty >= 0) boat.crew[empty] = playerIndex;
    else boat.crew.push(playerIndex);
  }
  player.mode = "boat";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  const native = nativeVesselForBoat(world, boat.id);
  setVesselOccupantPosition(native.definition, native.instance, playerIndex, position);
  return native;
}

function pulseAction(world, playerIndex) {
  setPlayerInput(world, playerIndex, {action: true});
  setPlayerInput(world, playerIndex, {action: false});
}

test("fastest vessel uses the shared two-deck architecture and one real mounted pistol", () => {
  const definition = stressDefinition();
  assert.ok(definition);
  assert.equal(definition.physics.mode, "module");
  assert.equal(definition.physics.module, STRESS_TEST_PHYSICS_ID);
  assert.equal(definition.capabilities.walkableInterior, true);
  assert.equal(definition.runtimeDefaults.crewCapacity, 2);
  assert.equal(definition.decks.length, 2);
  assert.deepEqual(definition.decks.map(deck => deck.id), ["stress-aft-deck", "stress-control-deck"]);
  assert.equal(definition.modules.filter(module => module.type === "propulsion").length, STRESS_TEST_ENGINE_COUNT);

  const controlDeck = definition.decks.find(deck => deck.id === "stress-control-deck");
  const driver = controlDeck.objects.find(object => object.id === "stress-driver-seat");
  const gunner = controlDeck.objects.find(object => object.id === "stress-pistol-station");
  assert.equal(driver.stationRole, "helm");
  assert.equal(driver.controlsVessel, true);
  assert.equal(gunner.stationRole, "weapon");
  assert.equal(gunner.controlsModule, "stress-pistol");

  const pistol = definition.modules.find(module => module.id === "stress-pistol");
  assert.equal(pistol.type, "mounted-weapon");
  assert.equal(pistol.config.ammo, STRESS_TEST_START_AMMO);
  assert.equal(pistol.config.interval, 0.04);
  assert.equal(pistol.config.inputMode, "station-attack");
  assert.equal(pistol.config.stationResourceId, "stress-pistol-control");
  assert.equal(definition.mounts.find(mount => mount.id === "stress-pistol-hardpoint").deckId, "stress-control-deck");
  assert.equal(definition.runtimeDefaults.audioProfile, STRESS_TEST_AUDIO_PROFILE);
});

test("stress physics still derives power from the actual fifty propulsion modules", () => {
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

test("driver and gunner occupy separate shared stations; only the gunner fires the same server weapon", () => {
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

  placeOnDeck(world, boat, 0, {deckId: "stress-control-deck", x: -1.15, y: 1.15, heading: 0});
  placeOnDeck(world, boat, 1, {deckId: "stress-control-deck", x: 1.15, y: 1.15, heading: 0});
  drainEvents(world);

  pulseAction(world, 0);
  assert.equal(boat.driver, 0, "driver seat must grant the existing vessel helm authority");
  assert.equal(native.instance.interior.claims["stress-helm-control"], 0);

  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.04);
  assert.equal(drainEvents(world).filter(event => event.type === "vessel-mounted-shot" && event.boatId === boat.id).length, 0, "driver must not magically fire the mounted pistol");

  pulseAction(world, 1);
  assert.equal(native.instance.interior.claims["stress-pistol-control"], 1);
  const seated = {...native.instance.occupants[1]};
  setPlayerInput(world, 1, {attack: true, right: true, jump: true});
  const shots = [];
  for (let index = 0; index < 4; index += 1) {
    stepFreeWorld(world, 0.04);
    shots.push(...drainEvents(world).filter(event => event.type === "vessel-mounted-shot" && event.boatId === boat.id));
  }
  assert.equal(shots.length, 4, "holding fire at the weapon station should keep producing rapid server hitscan shots");
  assert.equal(shots[0].sourcePlayer, 1);
  assert.equal(shots[0].stationId, "stress-pistol-station");
  assert.equal(shots[0].instant, true);
  assert.equal(shots[0].weapon, "stress-pistol");
  assert.equal(shots.at(-1).ammo, STRESS_TEST_START_AMMO - 4);
  assert.equal(boat.testWeaponAmmo, STRESS_TEST_START_AMMO - 4);
  assert.equal(native.instance.occupants[1].x, seated.x, "weapon operator must not walk away while still occupying the station");
  assert.equal(native.instance.occupants[1].y, seated.y, "weapon operator must remain at the physical station");
  assert.equal(world.freeDualTurretProjectiles, undefined, "stress weapon must not create legacy projectile collections");

  pulseAction(world, 1);
  assert.equal(native.instance.interior.claims["stress-pistol-control"], undefined);
  setPlayerInput(world, 1, {attack: true, right: true});
  stepFreeWorld(world, 0.08);
  const afterLeaving = drainEvents(world).filter(event => event.type === "vessel-mounted-shot" && event.boatId === boat.id);
  assert.equal(afterLeaving.length, 0, "leaving the station must immediately revoke mounted-weapon authority");
  assert.ok(native.instance.occupants[1].x > seated.x, "after leaving the station the player must be able to walk again");
});

test("stress engine is one versioned binary MP3 with the verified release checksum", async () => {
  assert.equal(STRESS_TEST_ENGINE_URL, "/assets/audio/vessels/stress-50-engine-v2.mp3?v=2");
  assert.equal(STRESS_TEST_ENGINE_LOOP_SECONDS, 1);
  const url = new URL("../public/assets/audio/vessels/stress-50-engine-v2.mp3", import.meta.url);
  const bytes = await readFile(url);
  assert.equal(bytes.byteLength, 25388);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "26c9dc85b8186d84cc742b058544337e22782d1b76b9f3a2658aa465da2eb516");
  const names = await readdir(new URL("../public/assets/audio/vessels/", import.meta.url));
  assert.equal(names.includes("stress-50-engine-v1.wav"), false, "obsolete placeholder WAV must be removed");
  assert.equal(names.some(name => /(?:\.part-|\.b64$|chunk-)/i.test(name)), false);
});
