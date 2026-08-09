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
definition.deckArchitecture.sinking = {
  ...definition.deckArchitecture.sinking,
  mode: "vessel-authority",
};

const engineDeck = definition.decks.find(deck => deck.id === "medium-engine-deck");
if (!engineDeck) throw new TypeError("medium vessel needs medium-engine-deck");

addRepairStation(engineDeck, {
  id: "medium-engine-repair-station",
  kind: "station",
  label: "ремонтный пост главного двигателя",
  position: [-1.35, -1.45],
  zoneId: "medium-engine-room",
  resourceId: "medium-engine-repair-control",
  stationRole: "repair",
  controlsModule: "engine",
  inputAuthority: ["repair"],
  interactionRange: 1.35,
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
  position: [1.35, -1.45],
  zoneId: "medium-engine-room",
  resourceId: "medium-pump-repair-control",
  stationRole: "repair",
  controlsModule: "bilge-pump",
  inputAuthority: ["repair"],
  interactionRange: 1.35,
  occupyLabel: "занять ремонтный пост помпы",
  leaveLabel: "отойти от ремонтного поста помпы",
  occupyText: "Ты у ремонтного поста трюмной помпы. Удерживай ремонт, чтобы восстанавливать помпу.",
  leaveText: "Ты отошёл от ремонтного поста помпы.",
  repair: {durationSeconds: 4.2, amount: 60, resourceField: "repairPatches"},
});

engineDeck.landmarks ||= [];
if (!engineDeck.landmarks.some(item => item.id === "medium-engine-repair-landmark")) {
  engineDeck.landmarks.push({id: "medium-engine-repair-landmark", label: "ремонтный пост двигателя", position: [-1.35, -1.45], zoneId: "medium-engine-room"});
}
if (!engineDeck.landmarks.some(item => item.id === "medium-pump-repair-landmark")) {
  engineDeck.landmarks.push({id: "medium-pump-repair-landmark", label: "ремонтный пост помпы", position: [1.35, -1.45], zoneId: "medium-engine-room"});
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
