import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createFreeWorld, setPlayerInput, stepFreeWorld} from "../public/src/free-roam-core-v8.js";
import {relativeMovementPan} from "../public/src/free-roam-audio-v3.js?v=38";
import {nativeVesselForBoat, vesselRegistry} from "../public/src/vessel/vessel-runtime.js?v=2";
import {setVesselOccupantPosition} from "../public/src/vessel/vessel-interior.js";
import {STRESS_TEST_START_AMMO, STRESS_TEST_VESSEL_TYPE} from "../public/src/vessel/stress-test-vessel-config.js?v=2";

const armoredBoat = world => (world.boats || []).find(boat => boat?.vesselType === "dual-turret-patrol" || boat?.boatType === "dual-turret-patrol");
const stressBoat = world => (world.boats || []).find(boat => boat?.vesselType === STRESS_TEST_VESSEL_TYPE || boat?.boatType === STRESS_TEST_VESSEL_TYPE);

function boardArmoredDeck(world) {
  const boat = armoredBoat(world);
  for (const candidate of world.boats || []) if (candidate && candidate !== boat) candidate.reserved = true;
  if (world.freeActivities?.crates) world.freeActivities.crates = [];
  Object.assign(boat, {driver: null, crew: [null, null], speed: 0});
  const player = world.players[0];
  Object.assign(player, {mode: "swim", activeBoat: null, vesselDeckInputOwned: false, x: boat.x, y: boat.y + 4});
  player.combat.carriedCrate = null;
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, 0, {action: false});
  return boat;
}

test("walkable deck speaks configured zones and announces a nearby common action only once", () => {
  const world = createFreeWorld();
  const boat = boardArmoredDeck(world);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.ok(entry?.instance?.occupants?.[0]);
  assert.ok(world.events.some(event => event.type === "vessel-deck-zone-enter" && event.targets?.includes(0) && /открытая палуба/i.test(event.text || "")));
  setVesselOccupantPosition(entry.definition, entry.instance, 0, {deckId: "armored-main-deck", x: 0, y: 2.1, heading: 0});
  const start = world.events.length;
  for (let index = 0; index < 4; index += 1) stepFreeWorld(world, 0.1);
  const available = world.events.slice(start).filter(event => event.type === "vessel-deck-action-available");
  assert.equal(available.length, 1);
  assert.match(available[0].text, /дверь лестничного люка/i);
  const repeated = world.events.length;
  stepFreeWorld(world, 0.1);
  assert.equal(world.events.slice(repeated).filter(event => event.type === "vessel-deck-action-available").length, 0);
  setVesselOccupantPosition(entry.definition, entry.instance, 0, {deckId: "armored-bridge-deck", x: 0, y: 0, heading: 0});
  const zoneStart = world.events.length;
  stepFreeWorld(world, 0.1);
  assert.ok(world.events.slice(zoneStart).some(event => event.type === "vessel-deck-zone-enter" && /рубка/i.test(event.text || "")));
});

test("fastest light vessel respawns fully after ten seconds without changing armored patrol recovery", () => {
  const world = createFreeWorld();
  stepFreeWorld(world, 0.05);
  const boat = stressBoat(world);
  const entry = nativeVesselForBoat(world, boat.id);
  assert.equal(entry.definition.lifecycle?.respawn?.delaySeconds, 10);
  assert.equal(vesselRegistry().resolveVesselType("dual-turret-patrol").lifecycle?.respawn, undefined);
  Object.assign(boat, {sunk: true, hull: 0, water: 100, engineStalled: true, testWeaponAmmo: 3});
  entry.instance.modules["stress-pistol"].ammo = 3;
  for (const [id, module] of Object.entries(entry.instance.modules)) if (id.startsWith("engine-")) module.health = 0;
  stepFreeWorld(world, 0.1);
  assert.equal(boat.sunk, true);
  for (let index = 0; index < 99; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(boat.sunk, true);
  stepFreeWorld(world, 0.1);
  assert.equal(boat.sunk, false);
  assert.deepEqual([boat.x, boat.y, boat.heading, boat.speed, boat.hull, boat.water, boat.armor], [210, 132, 180, 0, 180, 0, 0]);
  assert.equal(boat.testWeaponAmmo, STRESS_TEST_START_AMMO);
  assert.equal(entry.instance.modules["stress-pistol"].ammo, STRESS_TEST_START_AMMO);
  assert.ok(Object.entries(entry.instance.modules).filter(([id]) => id.startsWith("engine-")).every(([, module]) => module.health > 0 && module.enabled !== false));
  assert.ok(world.events.some(event => event.type === "vessel-respawn-complete" && event.boatId === boat.id));
});

test("armored custom engine keeps the shared foot/swim spatial law without an audio module cycle", async () => {
  const right = {x: 10, y: 0};
  assert.equal(relativeMovementPan({x: 0, y: 0, heading: 0, mode: "foot"}, right), 1);
  assert.equal(relativeMovementPan({x: 0, y: 0, heading: 180, mode: "foot"}, right), 1);
  assert.equal(relativeMovementPan({x: 0, y: 0, heading: 90, mode: "swim"}, right), 1);
  const source = await readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "\.\/free-roam-audio-v3\.js/);
  assert.match(source, /function vesselRelativePan\(listener, source\)/);
  assert.match(source, /\["foot", "swim"\]\.includes\(listener\?\.mode\).*clamp\(dx \/ Math\.max\(metres, 8\), -1, 1\)/s);
  assert.match(source, /vesselRelativePan\(listener, boat\)/);
});
