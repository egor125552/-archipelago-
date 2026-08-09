"use strict";

import {MEDIUM_CREW_VESSEL_DEFINITION as BASE_MEDIUM_CREW_VESSEL_DEFINITION} from "./medium-crew-vessel.js?v=1";
import {MEDIUM_CREW_AUDIO_PROFILE} from "../medium-crew-vessel-config.js?v=1";

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function addRepairStation(deck, station) {
  deck.objects ||= [];
  if (!deck.objects.some(object => object.id === station.id)) deck.objects.push(station);
}

function byId(items, id, label) {
  const item = (items || []).find(entry => entry.id === id);
  if (!item) throw new TypeError(`medium vessel needs ${label || id}`);
  return item;
}

function setPosition(item, position) {
  item.position = [...position];
  return item;
}

function setInteractionRange(item, range) {
  item.interactionRange = range;
  return item;
}

const definition = clone(BASE_MEDIUM_CREW_VESSEL_DEFINITION);
definition.subsystemAuthority = {
  flooding: "vessel-zonal-v2",
  damage: "vessel-zonal-v1",
  repair: "vessel-modules-v1",
  propulsion: "vessel-modules-v1",
  input: "vessel-stations-v1",
  audio: "vessel-custom-v1",
};
definition.runtimeDefaults.audioProfile = MEDIUM_CREW_AUDIO_PROFILE;
definition.runtimeDefaults.requestedAudioProfile = MEDIUM_CREW_AUDIO_PROFILE;
definition.runtimeDefaults.collisionRadius = 13.5;
definition.runtimeDefaults.boardingRange = 26;
definition.deckArchitecture.sinking = {
  ...definition.deckArchitecture.sinking,
  mode: "emergency-phase",
};

// The first practical deck layout was deliberately compact. The medium vessel is
// now a real walkable ship-sized space: roughly 24 m long across the two upper
// compartments, with a 12 x 12 m machinery room. Geometry, landmarks, stations,
// mounts and connection endpoints are moved together so navigation and audio
// describe the same physical layout.
const aftDeck = byId(definition.decks, "medium-aft-deck", "medium-aft-deck");
const cabinDeck = byId(definition.decks, "medium-cabin-deck", "medium-cabin-deck");
const engineDeck = byId(definition.decks, "medium-engine-deck", "medium-engine-deck");

aftDeck.shape = {outer: [[-7, -12], [7, -12], [7, 0.5], [-7, 0.5]]};
byId(aftDeck.zones, "medium-aft-zone").shape = {
  outer: [[-6.5, -11.5], [6.5, -11.5], [6.5, 0], [-6.5, 0]],
};
const pistolStation = setInteractionRange(
  setPosition(byId(aftDeck.objects, "medium-pistol-station"), [-4.2, -6.2]),
  3.2,
);
const heavyStation = setInteractionRange(
  setPosition(byId(aftDeck.objects, "medium-heavy-gun-station"), [4.2, -6.2]),
  3.2,
);
setPosition(byId(aftDeck.landmarks, "medium-pistol-landmark"), pistolStation.position);
setPosition(byId(aftDeck.landmarks, "medium-heavy-gun-landmark"), heavyStation.position);
setPosition(byId(aftDeck.landmarks, "medium-cabin-door-landmark"), [0, 0]);
const cabinDoorIn = setInteractionRange(byId(aftDeck.connections, "medium-cabin-door-in"), 3.2);
cabinDoorIn.from = [0, 0];
cabinDoorIn.to = [0, 0.65];

cabinDeck.shape = {outer: [[-6, 0], [6, 0], [6, 12], [-6, 12]]};
byId(cabinDeck.zones, "medium-cabin-zone").shape = {
  outer: [[-5.5, 0.5], [5.5, 0.5], [5.5, 11.5], [-5.5, 11.5]],
};
const driverSeat = setInteractionRange(
  setPosition(byId(cabinDeck.objects, "medium-driver-seat"), [-2.8, 5]),
  3,
);
const passengerSeat = setInteractionRange(
  setPosition(byId(cabinDeck.objects, "medium-passenger-seat"), [2.8, 5]),
  3,
);
setPosition(byId(cabinDeck.landmarks, "medium-driver-landmark"), driverSeat.position);
setPosition(byId(cabinDeck.landmarks, "medium-passenger-landmark"), passengerSeat.position);
setPosition(byId(cabinDeck.landmarks, "medium-engine-hatch-landmark"), [0, 10]);
setPosition(byId(cabinDeck.landmarks, "medium-aft-door-landmark"), [0, 0.65]);
const cabinDoorOut = setInteractionRange(byId(cabinDeck.connections, "medium-cabin-door-out"), 3.2);
cabinDoorOut.from = [0, 0.65];
cabinDoorOut.to = [0, 0];
const engineHatchDown = setInteractionRange(byId(cabinDeck.connections, "medium-engine-hatch-down"), 3.2);
engineHatchDown.from = [0, 10];
engineHatchDown.to = [0, 0];

engineDeck.shape = {outer: [[-6, -6], [6, -6], [6, 6], [-6, 6]]};
byId(engineDeck.zones, "medium-engine-room").shape = {
  outer: [[-5.5, -5.5], [5.5, -5.5], [5.5, 5.5], [-5.5, 5.5]],
};
setPosition(byId(engineDeck.landmarks, "medium-engine-landmark"), [-2.6, -2.2]);
setPosition(byId(engineDeck.landmarks, "medium-pump-landmark"), [2.6, -2.2]);
setPosition(byId(engineDeck.landmarks, "medium-hatch-up-landmark"), [0, 0]);
const engineHatchUp = setInteractionRange(byId(engineDeck.connections, "medium-engine-hatch-up"), 3.2);
engineHatchUp.from = [0, 0];
engineHatchUp.to = [0, 10];

const boardingPoint = byId(definition.deckArchitecture?.boarding?.points, "medium-aft-entry");
boardingPoint.position = [0, -10.5];

setPosition(byId(definition.mounts, "medium-pistol-hardpoint"), [-4.2, -6.6]);
setPosition(byId(definition.mounts, "medium-heavy-hardpoint"), [4.2, -6.6]);

addRepairStation(engineDeck, {
  id: "medium-engine-repair-station",
  kind: "station",
  label: "ремонтный пост главного двигателя",
  position: [-3.2, 2.5],
  zoneId: "medium-engine-room",
  resourceId: "medium-engine-repair-control",
  stationRole: "repair",
  controlsModule: "engine",
  inputAuthority: ["repair"],
  interactionRange: 3,
  occupyLabel: "занять ремонтный пост двигателя",
  leaveLabel: "отойти от ремонтного поста двигателя",
  occupyText: "Ты у ремонтного поста главного двигателя. Удерживай ремонт, чтобы восстанавливать двигатель.",
  leaveText: "Ты отошёл от ремонтного поста двигателя.",
  repair: {durationSeconds: 5.5, amount: 55, resourceField: "repairPatches"},
});

addRepairStation(engineDeck, {
  id: "medium-pump-repair-station",
  kind: "station",
  label: "ремонтный пост трюмной помпы",
  position: [3.2, 2.5],
  zoneId: "medium-engine-room",
  resourceId: "medium-pump-repair-control",
  stationRole: "repair",
  controlsModule: "bilge-pump",
  inputAuthority: ["repair"],
  interactionRange: 3,
  occupyLabel: "занять ремонтный пост помпы",
  leaveLabel: "отойти от ремонтного поста помпы",
  occupyText: "Ты у ремонтного поста трюмной помпы. Удерживай ремонт, чтобы восстанавливать помпу.",
  leaveText: "Ты отошёл от ремонтного поста помпы.",
  repair: {durationSeconds: 4.2, amount: 60, resourceField: "repairPatches"},
});

engineDeck.landmarks ||= [];
if (!engineDeck.landmarks.some(item => item.id === "medium-engine-repair-landmark")) {
  engineDeck.landmarks.push({
    id: "medium-engine-repair-landmark",
    label: "ремонтный пост двигателя",
    position: [-3.2, 2.5],
    zoneId: "medium-engine-room",
  });
}
if (!engineDeck.landmarks.some(item => item.id === "medium-pump-repair-landmark")) {
  engineDeck.landmarks.push({
    id: "medium-pump-repair-landmark",
    label: "ремонтный пост помпы",
    position: [3.2, 2.5],
    zoneId: "medium-engine-room",
  });
}

definition.damage ||= {};
definition.damage.zoneModuleChoices = {
  ...(definition.damage.zoneModuleChoices || {}),
  "medium-engine-room": ["engine", "bilge-pump"],
};

export const MEDIUM_CREW_VESSEL_DEFINITION = Object.freeze(definition);

export function installMediumCrewVesselType(registry) {
  registry.registerVesselType(MEDIUM_CREW_VESSEL_DEFINITION);
}
