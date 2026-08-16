"use strict";

// This late-bound runtime import is intentional: vessel-runtime installs this
// plugin while it is initializing, but spawnVessel is only called later from a
// gameplay phase, after the runtime module has completed initialization.
import {spawnVessel} from "../vessel-runtime.js?v=2";
import {
  STRESS_TEST_START_AMMO,
  STRESS_TEST_VESSEL_TYPE,
} from "../stress-test-vessel-config.js?v=2";


function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 240) world.events.splice(0, world.events.length - 240);
}

function isStressBoat(boat) {
  return Boolean(boat && (boat.vesselType === STRESS_TEST_VESSEL_TYPE || boat.boatType === STRESS_TEST_VESSEL_TYPE));
}

function testBoat(world) {
  return (world?.boats || []).find(isStressBoat) || null;
}

function ensureTestBoat(world) {
  const existing = testBoat(world);
  if (existing) return existing;
  const {boat} = spawnVessel(world, STRESS_TEST_VESSEL_TYPE, {
    x: 210,
    y: 132,
    heading: 180,
    state: {
      x: 210,
      y: 132,
      heading: 180,
      driver: null,
      crew: [],
      reserved: false,
      connectionActivated: true,
    },
  });
  emit(
    world,
    "stress-vessel-spawned",
    "У причала готов самый быстрый катер «Пятьдесят»: 50 двигателей, две маленькие палубы, кресло водителя и отдельный пост сверхскоростного пистолета.",
    [0, 1],
    {boatId: boat.id, boatType: boat.boatType, audioProfile: boat.audioProfile, x: boat.x, y: boat.y},
  );
  return boat;
}

function stressMountedWeapon(entry) {
  const definition = entry?.definition?.modules?.find(module => (
    module?.type === "mounted-weapon" && module?.id === "stress-pistol"
  ));
  if (!definition) return null;
  const state = entry.instance?.modules?.[definition.id];
  return state ? {definition, state} : null;
}

function syncStressAmmo({nativeVessels} = {}) {
  for (const entry of nativeVessels || []) {
    if (entry?.definition?.id !== STRESS_TEST_VESSEL_TYPE || !entry?.boat) continue;
    const mounted = stressMountedWeapon(entry);
    if (!mounted) continue;
    if (!mounted.state.stressAmmoHydrated) {
      const persistedAmmo = Number(entry.boat.testWeaponAmmo);
      if (Number.isFinite(persistedAmmo) && persistedAmmo >= 0) mounted.state.ammo = Math.floor(persistedAmmo);
      mounted.state.stressAmmoHydrated = true;
    }
    entry.boat.testWeaponAmmo = Math.max(0, Math.floor(Number(mounted.state.ammo) || 0));
  }
}

function announceBoarding(context) {
  const world = context?.world;
  if (!world) return;
  for (const event of (world.events || []).slice(context.eventStart || 0)) {
    if (!["enter", "vessel-deck-enter"].includes(event?.type)) continue;
    const boat = (world.boats || []).find(candidate => candidate?.id === event.boatId) || null;
    if (!isStressBoat(boat)) continue;
    const ammo = Math.max(0, Math.floor(Number(boat?.testWeaponAmmo) || STRESS_TEST_START_AMMO));
    event.boatType = STRESS_TEST_VESSEL_TYPE;
    event.text = `Ты на задней палубе самого быстрого катера «Пятьдесят». На рабочей палубе рядом кресло водителя и сверхскоростная пистолетная установка, ${ammo} патронов. Сначала займи нужный пост.`;
  }
}

export const STRESS_TEST_VESSEL_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "stress-test-vessel-spawner-v2",
    phase: "before-step",
    order: -100,
    run({world}) {
      if (world) ensureTestBoat(world);
    },
  }),
  Object.freeze({
  id: "stress-test-ammo-bridge-v1",
  phase: "before-step",
  order: 9,
  run: syncStressAmmo,
}),
Object.freeze({
  id: "stress-test-ammo-bridge-after-step-v1",
  phase: "after-step",
  order: 9,
  run: syncStressAmmo,
}),
  Object.freeze({
    id: "stress-test-boarding-announcer-after-input-v4",
    phase: "after-input",
    order: 20,
    run: announceBoarding,
  }),
  Object.freeze({
    id: "stress-test-boarding-announcer-after-step-v4",
    phase: "after-step",
    order: 20,
    run: announceBoarding,
  }),
]);
