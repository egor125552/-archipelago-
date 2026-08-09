import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {createFreeWorld, setPlayerInput, stepFreeWorld} from "../public/src/free-roam-core-v8.js";
import {relativeMovementPan} from "../public/src/free-roam-audio-v3.js?v=38";
import {nativeVesselForBoat, vesselRegistry} from "../public/src/vessel/vessel-runtime.js?v=2";
import {setVesselOccupantPosition} from "../public/src/vessel/vessel-interior.js";
import {STRESS_TEST_START_AMMO, STRESS_TEST_VESSEL_TYPE} from "../public/src/vessel/stress-test-vessel-config.js?v=2";

function armoredBoat(world) {
  return (world.boats || []).find(boat => boat?.vesselType === "dual-turret-patrol" || boat?.boatType === "dual-turret-patrol");
}

function stressBoat(world) {
  return (world.boats || []).find(boat => boat?.vesselType === STRESS_TEST_VESSEL_TYPE || boat?.boatType === STRESS_TEST_VESSEL_TYPE);
}

function boardArmoredDeck(world, playerIndex = 0) {
  const boat = armoredBoat(world);
  assert.ok(boat);
  for (const candidate of world.boats || []) if (candidate && candidate !== boat) candidate.reserved = true;
  if (world.freeActivities?.crates) world.freeActivities.crates = [];
  boat.driver = null;
  boat.crew = [null, null];
  boat.speed = 0;
  const player = world.players[playerIndex];
  player.mode = "swim";
  player.activeBoat = null;
  player.vesselDeckInputOwned = false;
  player.combat.carriedCrate = null;
  player.x = boat.x;
  player.y = boat.y + 4;
  setPlayerInput(world, playerIndex, {action: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, playerIndex, {action: false});
  return boat;
}

test("walkable deck speaks configured zones and announces a nearby common action only once", () => {
  const world = createFreeWorld();
  const boat = boardArmoredDeck(world, 0);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry?.instance?.occupants?.[0]);
  assert.ok(world.events.some(event => (
    event.type === "vessel-deck-zone-enter"
    && event.targets?.includes(0)
    && /открытая палуба/i.test(event.text || "")
  )), "boarding a first-entry zone must become a normal spoken server event");

  setVesselOccupantPosition(entry.definition, entry.instance, 0, {
    deckId: "armored-main-deck",
    x: 0,
    y: 2.1,
    heading: 0,
  });
  const firstStart = world.events.length;
  for (let index = 0; index < 4; index += 1) stepFreeWorld(world, 0.1);
  const first = world.events.slice(firstStart).filter(event => event.type === "vessel-deck-action-available");
  assert.equal(first.length, 1);
  assert.match(first[0].text, /дверь лестничного люка/i);
  assert.match(first[0].text, /открыть/i);

  const repeatedStart = world.events.length;
  stepFreeWorld(world, 0.1);
  assert.equal(world.events.slice(repeatedStart).filter(event => event.type === "vessel-deck-action-available").length, 0, "standing beside one action must not spam TTS every server tick");

  setVesselOccupantPosition(entry.definition, entry.instance, 0, {
    deckId: "armored-bridge-deck",
    x: 0,
    y: 0,
    heading: 0,
  });
  const zoneStart = world.events.length;
  stepFreeWorld(world, 0.1);
  const zoneEvents = world.events.slice(zoneStart).filter(event => event.type === "vessel-deck-zone-enter");
  assert.ok(zoneEvents.some(event => /рубка/i.test(event.text || "")), "moving to another configured zone must produce speech through the common event stream");
});

test("fastest light vessel respawns fully after ten seconds without changing armored patrol recovery", () => {
  const world = createFreeWorld();
  stepFreeWorld(world, 0.05);
  const boat = stressBoat(world);
  assert.ok(boat, "stress light vessel must be spawned by the common vessel plugin");
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry);
  assert.equal(entry.definition.lifecycle?.respawn?.delaySeconds, 10);
  assert.equal(vesselRegistry().resolveVesselType("dual-turret-patrol").lifecycle?.respawn, undefined, "armored patrol keeps its existing separate 60 second recovery");

  boat.sunk = true;
  boat.hull = 0;
  boat.water = 100;
  boat.engineStalled = true;
  boat.testWeaponAmmo = 3;
  entry.instance.modules["stress-pistol"].ammo = 3;
  for (const [id, module] of Object.entries(entry.instance.modules)) {
    if (id.startsWith("engine-")) module.health = 0;
  }

  const startIndex = world.events.length;
  stepFreeWorld(world, 0.1);
  assert.equal(boat.sunk, true);
  assert.ok(world.events.slice(startIndex).some(event => event.type === "vessel-respawn-start" && event.seconds === 10));

  for (let index = 0; index < 99; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(boat.sunk, true, "vessel must remain sunk before the full ten second recovery interval elapses");
  stepFreeWorld(world, 0.1);

  assert.equal(boat.sunk, false);
  assert.equal(boat.x, 210);
  assert.equal(boat.y, 132);
  assert.equal(boat.heading, 180);
  assert.equal(boat.speed, 0);
  assert.equal(boat.hull, 180);
  assert.equal(boat.water, 0);
  assert.equal(boat.armor, 0);
  assert.equal(boat.testWeaponAmmo, STRESS_TEST_START_AMMO);
  assert.equal(entry.instance.modules["stress-pistol"].ammo, STRESS_TEST_START_AMMO);
  assert.ok(Object.entries(entry.instance.modules).filter(([id]) => id.startsWith("engine-")).every(([, module]) => module.health > 0 && module.enabled !== false));
  assert.ok(world.events.some(event => event.type === "vessel-respawn-complete" && event.boatId === boat.id));
});

test("armored custom engine uses the shared listener-relative vessel spatial transform", async () => {
  const east = {x: 10, y: 0};
  assert.equal(relativeMovementPan({x: 0, y: 0, heading: 0, mode: "foot"}, east), 1, "east is right while the listener faces north");
  assert.equal(relativeMovementPan({x: 0, y: 0, heading: 180, mode: "foot"}, east), -1, "turning around must move the same physical source to the listener's left");
  assert.ok(Math.abs(relativeMovementPan({x: 0, y: 0, heading: 90, mode: "swim"}, east)) < 1e-9, "a source straight ahead must be centered while swimming too");

  const source = await readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8");
  assert.match(source, /import \{relativeVesselPan\} from "\.\/vessel\/vessel-audio-policy\.js\?v=1"/);
  assert.match(source, /relativeVesselPan\(listener, boat\)/);
  assert.doesNotMatch(source, /function relativePan\(/, "armored engine must not carry a parallel spatializer");
});