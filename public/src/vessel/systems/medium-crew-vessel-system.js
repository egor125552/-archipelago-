"use strict";

// Late-bound like the existing stress-vessel spawner: this system is installed
// while vessel-runtime initializes, but spawnVessel is only invoked later.
import {spawnVessel} from "../vessel-runtime.js?v=2";
import {installMediumCrewVesselType} from "../definitions/medium-crew-vessel-v2.js?v=1";
import {
  MEDIUM_CREW_AUDIO_PROFILE,
  MEDIUM_CREW_SPAWN,
  MEDIUM_CREW_VESSEL_TYPE,
} from "../medium-crew-vessel-config.js?v=2";

const MEDIUM_CREW_PLACEMENT_VERSION = 2;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 260) world.events.splice(0, world.events.length - 260);
}

function mediumBoat(world) {
  return (world?.boats || []).find(boat => boat?.mediumCrewMarker === true) || null;
}

function playerIsAboard(world, boat) {
  return (world?.players || []).some(player => (
    player && Number.isInteger(player.activeBoat) && player.activeBoat === boat?.id
  ));
}

function normalizeMediumAuthorityFields(boat) {
  if (!boat) return;
  boat.fleetService = true;
  boat.manualRecoveryOnly = true;
  boat.mediumCrewMarker = true;
  boat.audioProfile = MEDIUM_CREW_AUDIO_PROFILE;
  boat.requestedAudioProfile = MEDIUM_CREW_AUDIO_PROFILE;
}

function migrateExistingMediumBoat(world, boat) {
  if (!boat || Number(boat.mediumCrewPlacementVersion) >= MEDIUM_CREW_PLACEMENT_VERSION) return false;
  // Never teleport a player who is currently standing on / driving the vessel.
  if (playerIsAboard(world, boat)) return false;

  boat.x = MEDIUM_CREW_SPAWN.x;
  boat.y = MEDIUM_CREW_SPAWN.y;
  boat.heading = MEDIUM_CREW_SPAWN.heading;
  boat.speed = 0;
  boat.throttle = 0;
  boat.rudder = 0;

  // One-time repair/migration for the test vessel. An older saved world may
  // already contain an invisible/sunk copy at the previous coordinates; that
  // stale copy used to block the spawner forever.
  boat.sunk = false;
  boat.hull = Math.max(1, Number(boat.hullMax) || Number(boat.hull) || 220);
  boat.water = 0;
  boat.leak = 0;
  boat.engineStalled = false;
  boat.mediumCrewPlacementVersion = MEDIUM_CREW_PLACEMENT_VERSION;
  normalizeMediumAuthorityFields(boat);

  emit(
    world,
    "medium-crew-vessel-relocated",
    "Средний двухместный корабль переставлен к торговцу. От торговца иди назад к воде — корабль стоит совсем рядом в воде.",
    [0, 1],
    {boatId: boat.id, x: boat.x, y: boat.y},
  );
  return true;
}

function ensureMediumBoat(world, registry) {
  if (!registry?.resolveVesselType?.(MEDIUM_CREW_VESSEL_TYPE)) installMediumCrewVesselType(registry);
  const existing = mediumBoat(world);
  if (existing) {
    normalizeMediumAuthorityFields(existing);
    migrateExistingMediumBoat(world, existing);
    return existing;
  }

  // Saved worlds may restore/reset their clock differently. The vessel is
  // therefore guaranteed on the first vessel-system tick instead of depending
  // on a client-side delay.
  const {boat} = spawnVessel(world, MEDIUM_CREW_VESSEL_TYPE, {
    x: MEDIUM_CREW_SPAWN.x,
    y: MEDIUM_CREW_SPAWN.y,
    heading: MEDIUM_CREW_SPAWN.heading,
    state: {
      x: MEDIUM_CREW_SPAWN.x,
      y: MEDIUM_CREW_SPAWN.y,
      heading: MEDIUM_CREW_SPAWN.heading,
      owner: null,
      driver: null,
      crew: [],
      reserved: false,
      connectionActivated: true,
      fleetService: true,
      manualRecoveryOnly: true,
      mediumCrewMarker: true,
      mediumCrewPlacementVersion: MEDIUM_CREW_PLACEMENT_VERSION,
      audioProfile: MEDIUM_CREW_AUDIO_PROFILE,
      requestedAudioProfile: MEDIUM_CREW_AUDIO_PROFILE,
    },
  });
  normalizeMediumAuthorityFields(boat);
  emit(
    world,
    "medium-crew-vessel-spawned",
    "У торговца в воде появился средний двухместный корабль. От торговца иди назад к воде — он стоит совсем рядом. В кормовом отсеке две оружейные установки, за герметичной дверью рубка с креслом водителя и пассажирским креслом, ниже машинное отделение.",
    [0, 1],
    {boatId: boat.id, x: boat.x, y: boat.y},
  );
  return boat;
}

function normalizeBoarding(context) {
  const world = context?.world;
  const boat = mediumBoat(world);
  if (!world || !boat) return;
  normalizeMediumAuthorityFields(boat);
  for (const event of (world.events || []).slice(context.eventStart || 0)) {
    if (!["enter", "vessel-deck-enter"].includes(event?.type) || event.boatId !== boat.id) continue;
    const playerIndex = Number.isInteger(event.sourcePlayer)
      ? event.sourcePlayer
      : event.targets?.find(Number.isInteger);
    if (Number.isInteger(playerIndex) && !Number.isInteger(boat.owner)) boat.owner = playerIndex;
    event.text = "Ты на среднем двухместном корабле. Сейчас ты в кормовом отсеке: слева пистолетная установка, справа тяжёлая установка. Герметичная дверь ведёт в рубку; из рубки люк ведёт в машинное отделение.";
  }
}

export const MEDIUM_CREW_VESSEL_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "medium-crew-vessel-spawner-v3",
    phase: "before-step",
    order: -90,
    run({world, registry}) {
      if (world && registry) ensureMediumBoat(world, registry);
    },
  }),
  Object.freeze({
    id: "medium-crew-vessel-boarding-after-input-v3",
    phase: "after-input",
    order: 21,
    run: normalizeBoarding,
  }),
  Object.freeze({
    id: "medium-crew-vessel-boarding-after-step-v3",
    phase: "after-step",
    order: 21,
    run: normalizeBoarding,
  }),
]);
