import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  createFreeWorld,
  setPlayerInput,
  setPlayerPresence,
  stepFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {
  applyDualTurretBoatDamage,
  dualTurretBoat,
  prepareDualTurretBoatRoom,
} from "../public/src/free-roam-dual-turret-boat.js";
import {replicatedFreeWorld} from "../public/src/free-roam-replication-v2.js";
import {
  DUAL_TURRET_SHOT_DAMAGE,
  DUAL_TURRET_SHOT_INTERVAL,
} from "../public/src/free-roam-dual-turret-config.js";

function clearNearbyCargo(world, x = 20, y = 20) {
  for (const crate of world.freeActivities?.crates || []) {
    crate.state = "world";
    crate.carriedBy = null;
    crate.stowedBoat = null;
    crate.x = x;
    crate.y = y;
  }
}

function isolateBoat(world, selected) {
  for (const boat of world.boats || []) {
    if (!boat || boat.id === selected.id) continue;
    boat.x = 30 + boat.id * 20;
    boat.y = 290;
    boat.speed = 0;
    boat.reserved = true;
  }
}

function placePlayer(world, playerIndex, {mode = "foot", boat = null, x = 210, y = 180} = {}) {
  setPlayerPresence(world, playerIndex, true);
  const player = world.players[playerIndex];
  player.mode = mode;
  player.activeBoat = boat?.id ?? null;
  player.x = boat?.x ?? x;
  player.y = boat?.y ?? y;
  player.heading = boat?.heading ?? 0;
  player.combat.alive = true;
  player.combat.health = 100;
}

function pulse(world, playerIndex, input, dt = 0.05) {
  setPlayerInput(world, playerIndex, input);
  stepFreeWorld(world, dt);
  setPlayerInput(world, playerIndex, {});
  stepFreeWorld(world, dt);
}

function seatCrew(world, boat, driver = 0, passenger = null) {
  setPlayerPresence(world, driver, true);
  boat.driver = driver;
  boat.crew = [driver, passenger];
  placePlayer(world, driver, {mode: "boat", boat});
  if (Number.isInteger(passenger)) {
    setPlayerPresence(world, passenger, true);
    placePlayer(world, passenger, {mode: "boat", boat});
  }
  stepFreeWorld(world, 0.01);
}

test("armored patrol is one registered boat with one controller state", () => {
  const world = createFreeWorld();
  const boat = dualTurretBoat(world);
  assert.equal(world.boats[boat.id], boat);
  assert.equal(world.freeDualTurretBoat.boatId, boat.id);
  assert.equal(world.freeDualTurretBoat.version, "4.0.0");
  assert.equal(boat.boatType, "dual-turret-patrol");
  assert.equal(boat.hull, 300);
  assert.equal(boat.hullMax, 300);
  assert.equal(boat.armor, 200);
  assert.equal(boat.crewCapacity, 2);
  assert.equal(boat.audioProfile, "dual-turret");
  assert.equal(boat.turrets, world.freeDualTurretBoat.turrets);
  assert.equal(world.freePlayerBoats, undefined);
  assert.equal(world.freeDualTurretPurchase, undefined);
  assert.equal(world.freeDualTurretPrototype, undefined);
  assert.equal(world.freeDualTurretWeapons, undefined);
  assert.equal(world.freeDualTurretProjectiles, undefined);
});

test("first crew member boards through the ordinary free-boat law", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  clearNearbyCargo(world);
  isolateBoat(world, boat);
  placePlayer(world, 0, {x: boat.x - 4, y: boat.y});
  world.boats[0].driver = null;
  world.boats[0].crew = [null];

  pulse(world, 0, {action: true});

  assert.equal(world.players[0].mode, "boat");
  assert.equal(world.players[0].activeBoat, boat.id);
  assert.equal(boat.driver, 0);
  assert.equal(boat.crew[0], 0);
  assert.equal(boat.turrets[0].assignedPlayer, 0);
});

test("second crew member uses only the small patrol controller", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  clearNearbyCargo(world);
  isolateBoat(world, boat);
  seatCrew(world, boat, 0, null);
  placePlayer(world, 1, {x: boat.x + 4, y: boat.y});

  pulse(world, 1, {action: true});

  assert.equal(world.players[1].mode, "boat");
  assert.equal(world.players[1].activeBoat, boat.id);
  assert.deepEqual(boat.crew, [0, 1]);
  assert.equal(boat.driver, 0);
  assert.equal(boat.turrets[1].assignedPlayer, 1);
});

test("armored patrol uses the common physics engine with a heavier profile", () => {
  const ordinaryWorld = createFreeWorld();
  const ordinary = ordinaryWorld.boats[0];
  clearNearbyCargo(ordinaryWorld);
  isolateBoat(ordinaryWorld, ordinary);
  ordinary.reserved = false;
  ordinary.driver = 0;
  ordinary.crew = [0];
  Object.assign(ordinary, {x: 210, y: 210, heading: 0, speed: 0, throttle: 0, rudder: 0, engineStalled: false});
  placePlayer(ordinaryWorld, 0, {mode: "boat", boat: ordinary});

  const patrolWorld = createFreeWorld();
  const patrol = prepareDualTurretBoatRoom(patrolWorld);
  clearNearbyCargo(patrolWorld);
  isolateBoat(patrolWorld, patrol);
  patrol.reserved = false;
  Object.assign(patrol, {x: 210, y: 210, heading: 0, speed: 0, throttle: 0, rudder: 0, engineStalled: false});
  seatCrew(patrolWorld, patrol, 0, null);

  setPlayerInput(ordinaryWorld, 0, {up: true, right: true});
  setPlayerInput(patrolWorld, 0, {up: true, right: true});
  for (let index = 0; index < 12; index += 1) {
    stepFreeWorld(ordinaryWorld, 0.05);
    stepFreeWorld(patrolWorld, 0.05);
  }

  assert.ok(patrol.speed < ordinary.speed, `${ordinary.speed} versus ${patrol.speed}`);
  assert.ok(Math.abs(patrol.heading) < Math.abs(ordinary.heading), `${ordinary.heading} versus ${patrol.heading}`);
  assert.ok(Math.hypot(patrol.x - 210, patrol.y - 210) < Math.hypot(ordinary.x - 210, ordinary.y - 210));
});

test("driver really exits into open water and is not pulled back aboard", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  clearNearbyCargo(world);
  isolateBoat(world, boat);
  boat.reserved = false;
  Object.assign(boat, {x: 210, y: 210, speed: 0, throttle: 0, rudder: 0});
  seatCrew(world, boat, 0, null);

  pulse(world, 0, {action: true});

  assert.equal(world.players[0].mode, "swim");
  assert.equal(world.players[0].activeBoat, null);
  assert.equal(boat.driver, null);
  assert.deepEqual(boat.crew, [null, null]);
  assert.ok(world.events.some(event => event.type === "exit" && event.targets.includes(0)));
});

test("passenger can exit into open water without removing the driver", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  clearNearbyCargo(world);
  isolateBoat(world, boat);
  boat.reserved = false;
  Object.assign(boat, {x: 210, y: 210, speed: 0, throttle: 0, rudder: 0});
  seatCrew(world, boat, 0, 1);

  pulse(world, 1, {action: true});

  assert.equal(world.players[1].mode, "swim");
  assert.equal(world.players[1].activeBoat, null);
  assert.equal(world.players[0].mode, "boat");
  assert.equal(boat.driver, 0);
  assert.deepEqual(boat.crew, [0, null]);
});

test("nearby cargo is loaded instead of triggering an exit", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  clearNearbyCargo(world);
  isolateBoat(world, boat);
  boat.reserved = false;
  Object.assign(boat, {x: 210, y: 190, speed: 0});
  seatCrew(world, boat, 0, null);
  const crate = world.freeActivities.crates.find(candidate => candidate.kind === "fuel");
  crate.x = boat.x + 2;
  crate.y = boat.y;

  pulse(world, 0, {action: true});

  assert.equal(world.players[0].mode, "boat");
  assert.equal(crate.state, "stowed");
  assert.equal(crate.stowedBoat, boat.id);
  assert.ok(boat.cargo.includes(crate.id));
});

test("sonar steering is applied once by the driver even with two crew members", () => {
  const oneCrewWorld = createFreeWorld();
  const oneCrewBoat = prepareDualTurretBoatRoom(oneCrewWorld);
  clearNearbyCargo(oneCrewWorld);
  isolateBoat(oneCrewWorld, oneCrewBoat);
  oneCrewBoat.reserved = false;
  Object.assign(oneCrewBoat, {x: 210, y: 210, speed: 5, heading: 0, sonarGuideSteer: 0.24});
  seatCrew(oneCrewWorld, oneCrewBoat, 0, null);

  const twoCrewWorld = createFreeWorld();
  const twoCrewBoat = prepareDualTurretBoatRoom(twoCrewWorld);
  clearNearbyCargo(twoCrewWorld);
  isolateBoat(twoCrewWorld, twoCrewBoat);
  twoCrewBoat.reserved = false;
  Object.assign(twoCrewBoat, {x: 210, y: 210, speed: 5, heading: 0, sonarGuideSteer: 0.24});
  seatCrew(twoCrewWorld, twoCrewBoat, 0, 1);

  stepFreeWorld(oneCrewWorld, 0.05);
  stepFreeWorld(twoCrewWorld, 0.05);

  assert.notEqual(oneCrewBoat.heading, 0);
  assert.ok(Math.abs(oneCrewBoat.heading - twoCrewBoat.heading) < 0.0001, `${oneCrewBoat.heading} versus ${twoCrewBoat.heading}`);
});

test("passenger cannot steer but can use the common pump and repair controls", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  clearNearbyCargo(world);
  isolateBoat(world, boat);
  boat.reserved = false;
  Object.assign(boat, {x: 210, y: 210, speed: 0, heading: 0, water: 60, leak: 0, hull: 250, armor: 150});
  seatCrew(world, boat, 0, 1);
  const heading = boat.heading;
  const water = boat.water;

  setPlayerInput(world, 1, {up: true, right: true, pump: true, repair: true});
  for (let index = 0; index < 36; index += 1) stepFreeWorld(world, 0.1);

  assert.equal(boat.heading, heading);
  assert.equal(boat.speed, 0);
  assert.ok(boat.water < water);
  assert.ok(boat.hull > 250);
});

test("mounted installation is fast, instant and stores no projectile world", () => {
  assert.equal(DUAL_TURRET_SHOT_INTERVAL, 0.18);
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  clearNearbyCargo(world);
  isolateBoat(world, boat);
  boat.reserved = false;
  seatCrew(world, boat, 0, null);
  const target = world.freeActivities.marauder;
  assert.ok(target);
  target.active = true;
  target.destroyed = false;
  target.hull = 100;
  target.x = boat.x;
  target.y = boat.y - 40;
  world.players[0].combat.equipped = "dual-turret";
  world.players[0].combat.lockedTargetId = target.id;
  const ammo = boat.turrets[0].ammo;

  setPlayerInput(world, 0, {attack: true});
  stepFreeWorld(world, 0.05);

  assert.equal(target.hull, 100 - DUAL_TURRET_SHOT_DAMAGE);
  assert.equal(boat.turrets[0].ammo, ammo - 1);
  assert.ok(world.freeDualTurretBoat.nextShotId > 1);
  assert.equal(world.freeDualTurretProjectiles, undefined);
  assert.ok(world.events.some(event => event.type === "dual-turret-hit" && event.instant));
});

test("300-point hull and armor use the common boat damage law", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  const beforeHull = boat.hull;
  const beforeArmor = boat.armor;
  const result = applyDualTurretBoatDamage(world, boat, 20, {emit: false});
  assert.ok(result.absorbed > 0);
  assert.equal(boat.hull, beforeHull - result.damage);
  assert.equal(boat.armor, beforeArmor - result.absorbed);
  assert.equal(boat.hullMax, 300);
});

test("replication exposes one compact controller and normal boat fields", () => {
  const world = createFreeWorld();
  const boat = prepareDualTurretBoatRoom(world);
  boat.crew = [0, 1];
  boat.turrets[0].assignedPlayer = 0;
  world.freeDualTurretBoat.weaponMode = "instant";
  const snapshot = replicatedFreeWorld(world);
  const replicated = snapshot.boats.find(candidate => candidate.boatType === "dual-turret-patrol");
  assert.equal(replicated.hull, 300);
  assert.equal(replicated.hullMax, 300);
  assert.equal(replicated.audioProfile, "dual-turret");
  assert.deepEqual(replicated.crew, [0, 1]);
  assert.equal(replicated.turrets.length, 2);
  assert.deepEqual(snapshot.freeDualTurretBoat, {
    version: "4.0.0",
    boatId: boat.id,
    weaponMode: "instant",
    recoveryRemaining: null,
  });
  assert.equal(snapshot.freeDualTurretProjectiles, undefined);
});

test("source contains one controller, one custom engine and no second physics runtime", async () => {
  const [core, controller, weapons, projectiles, client, audio, steering, replication] = await Promise.all([
    readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-boat.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-weapons.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-projectiles.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-client.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-core-v4.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-replication-v2.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(core, /free-roam-player-boats/);
  assert.doesNotMatch(controller, /preparePlayerBoatStep|finishPlayerBoatStep|applyMotionProfile/);
  assert.doesNotMatch(weapons, /freeDualTurretWeapons/);
  assert.doesNotMatch(projectiles, /freeDualTurretProjectiles\s*\|\|=/);
  assert.match(audio, /dual-turret-engine-v1\.mp3/);
  assert.doesNotMatch(client, /customBoat\.engineStalled\s*=/);
  assert.match(audio, /updateDualTurretEngine/);
  assert.match(steering, /boat\.driver !== playerIndex/);
  assert.match(replication, /freeDualTurretBoat/);
});