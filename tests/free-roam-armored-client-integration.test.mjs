import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {predictLocalWorld} from "../public/src/free-roam-client-prediction.js";
import {applyBoatPhysicsProfiles, captureBoatPhysicsState, resolveBoatPhysicsProfile} from "../public/src/free-roam-boat-physics.js";
import {attachBoatTransitionMetadata} from "../public/src/free-roam-boat-events.js";
import {DUAL_TURRET_PHYSICS_PROFILE} from "../public/src/free-roam-dual-turret-config.js";
import {handleDualTurretAudioEvent} from "../public/src/free-roam-dual-turret-audio.js";

function predictedWorld(physicsProfile = null) {
  const boat = {id: 0, driver: 0, x: 210, y: 210, heading: 0, speed: 0, throttle: 0, collisionRadius: physicsProfile ? 7.5 : 6, physicsProfile: physicsProfile ? {...physicsProfile} : undefined, engineStalled: false, emergencyActive: false, sunk: false};
  return {boats: [boat], players: [{mode: "boat", activeBoat: 0, x: boat.x, y: boat.y, heading: 0, combat: {}}]};
}

test("armored mini-physics stays inside the common profile law", () => {
  const tuning = {maxSpeed: 21, reverseSpeed: -6, acceleration: 8.4, drag: 0.09};
  const standard = resolveBoatPhysicsProfile({}, tuning);
  const armored = resolveBoatPhysicsProfile({physicsProfile: DUAL_TURRET_PHYSICS_PROFILE}, tuning);
  assert.equal(standard.maxForwardSpeed, 21);
  assert.equal(armored.maxForwardSpeed, 13.5);
  assert.equal(armored.maxReverseSpeed, 4.8);
  assert.ok(armored.acceleration < standard.acceleration);
  assert.ok(armored.turnFactor < standard.turnFactor);
  const world = predictedWorld(DUAL_TURRET_PHYSICS_PROFILE);
  const before = captureBoatPhysicsState(world);
  Object.assign(world.boats[0], {speed: 1, heading: 10, rudder: 1, x: 210.02, y: 209.95});
  applyBoatPhysicsProfiles(world, before, 0.05, {tuning});
  assert.ok(world.boats[0].speed < 1);
  assert.ok(world.boats[0].heading > 0 && world.boats[0].heading < 10);
  assert.ok(world.boats[0].rudder > 0 && world.boats[0].rudder < 1);
});

test("client prediction uses the same generic profile and feels heavier", () => {
  const ordinary = predictedWorld();
  const armored = predictedWorld(DUAL_TURRET_PHYSICS_PROFILE);
  for (let index = 0; index < 30; index += 1) {
    predictLocalWorld(ordinary, 0, {up: true, right: true}, 0.05);
    predictLocalWorld(armored, 0, {up: true, right: true}, 0.05);
  }
  assert.ok(armored.boats[0].speed < ordinary.boats[0].speed);
  assert.ok(Math.abs(armored.boats[0].heading) < Math.abs(ordinary.boats[0].heading));
  assert.ok(Math.hypot(armored.boats[0].x - 210, armored.boats[0].y - 210) < Math.hypot(ordinary.boats[0].x - 210, ordinary.boats[0].y - 210));
});

test("exit keeps boat identity for merchant and armored boarding audio", () => {
  const world = {boats: [{id: 2, boatType: "dual-turret-patrol", label: "двухместный бронекатер", audioProfile: "dual-turret"}], players: [{mode: "foot", activeBoat: null}], events: [{type: "exit", text: "Ты вышел на берег.", targets: [0]}]};
  attachBoatTransitionMetadata(world, 0, [2]);
  assert.equal(world.events[0].boatId, 2);
  assert.equal(world.events[0].audioProfile, "dual-turret");
  assert.equal(world.players[0].lastBoatId, 2);
  const played = [];
  const handled = handleDualTurretAudioEvent({play(name, options) { played.push({name, options}); }}, world.events[0], 0);
  assert.equal(handled, true);
  assert.equal(played[0]?.name, "dualTurretBoarding");
});

test("integration source has no armored-only parallel physics or owner-only merchant rule", async () => {
  const [prediction, core, profile, events, shop, audio, audioV2, headers] = await Promise.all([
    readFile(new URL("../public/src/free-roam-client-prediction.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-boat-physics.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-boat-events.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-shop-v10.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/_headers", import.meta.url), "utf8").catch(() => ""),
  ]);
  assert.match(prediction, /resolveBoatPhysicsProfile/);
  assert.doesNotMatch(prediction, /boatType\s*===\s*["']dual-turret/);
  assert.doesNotMatch(prediction, /isDualTurretBoat/);
  assert.match(core, /applyBoatPhysicsProfiles/);
  assert.match(profile, /boat\.physicsProfile/);
  assert.match(events, /lastBoatId/);
  assert.match(shop, /merchantBoatForPlayer/);
  assert.match(shop, /player\?\.lastBoatId/);
  assert.match(shop, /boat\.hull = hullMax/);
  assert.match(shop, /boat\.armor = armorMax/);
  assert.match(audio, /dual-turret-boarding-v1\.mp3\?v=1/);
  assert.match(audio, /String\(event\.audioProfile \|\| ""\)\.startsWith\("dual-turret"\)/);
  assert.match(audioV2, /free-roam-dual-turret-audio\.js\?v=\d+/);
  if (headers) assert.match(headers, /Cache-Control: no-cache, must-revalidate/);
});
