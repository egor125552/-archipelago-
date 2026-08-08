"use strict";

import {FreeRoamAudio} from "../free-roam-audio-v5.js?v=45";
import {MEDIUM_CREW_VESSEL_TYPE} from "./medium-crew-vessel-config.js?v=1";

const OPERATOR_RESOURCES = Object.freeze({
  "medium-pistol-control": Object.freeze({moduleId: "medium-pistol", label: "пистолетная установка"}),
  "medium-heavy-gun-control": Object.freeze({moduleId: "medium-heavy-gun", label: "тяжёлая установка"}),
});

function mediumBoatForPlayer(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (!player || !["boat", "roof"].includes(player.mode)) return null;
  const boat = world?.boats?.[player.activeBoat] || null;
  return boat?.mediumCrewMarker === true ? boat : null;
}

function networkVessel(world, boat) {
  return (world?.vesselArchitecture?.vessels || []).find(vessel => (
    vessel?.legacyBoatId === boat?.id || vessel?.instanceId === boat?.vesselInstanceId
  )) || null;
}

function controlledWeapon(network, playerIndex) {
  for (const [resourceId, descriptor] of Object.entries(OPERATOR_RESOURCES)) {
    if (network?.interior?.claims?.[resourceId] !== playerIndex) continue;
    const ammo = Math.max(0, Math.floor(Number(network?.modules?.[descriptor.moduleId]?.ammo) || 0));
    return {...descriptor, ammo};
  }
  return null;
}

function updateMediumCrewUi(world, playerIndex) {
  if (typeof document === "undefined") return;
  const boat = mediumBoatForPlayer(world, playerIndex);
  if (!boat) return;
  const weapon = controlledWeapon(networkVessel(world, boat), playerIndex);
  if (!weapon) return;
  const weaponValue = document.getElementById("weaponValue");
  const attackButton = document.getElementById("attackButton");
  if (weaponValue) weaponValue.textContent = `${weapon.label}, ${weapon.ammo}`;
  if (attackButton) attackButton.textContent = `Огонь: ${weapon.label}`;
}

function handleMediumShot(audio, event, playerIndex) {
  if (event?.type !== "vessel-mounted-shot" || event.boatType !== MEDIUM_CREW_VESSEL_TYPE || !event.targets?.includes(playerIndex)) return false;
  const spatial = audio.eventPanAndGain?.(event, event.weapon === "dual-turret" ? 420 : 320) || {pan: 0, gain: 1};
  if (event.weapon === "dual-turret" && audio.buffers?.has("dualTurretShot")) {
    audio.play?.("dualTurretShot", {pan: spatial.pan, gain: 0.34 * spatial.gain, rate: 0.98 + Math.random() * 0.035, lowpass: 9800});
    return true;
  }
  if (audio.buffers?.has("pistolShot")) {
    if (typeof audio.playExcerpt === "function") {
      audio.playExcerpt("pistolShot", {offset: 0, duration: 0.13, pan: spatial.pan, gain: 0.12 * spatial.gain, rate: 1.18, lowpass: 12500});
    } else {
      audio.play?.("pistolShot", {pan: spatial.pan, gain: 0.08 * spatial.gain, rate: 1.18, lowpass: 12500});
    }
    return true;
  }
  if (audio.buffers?.has("automaticShot")) {
    audio.play?.("automaticShot", {pan: spatial.pan, gain: 0.1 * spatial.gain, rate: event.weapon === "dual-turret" ? 0.84 : 1.2, lowpass: 10500});
  } else {
    audio.playSynthPip?.({pan: spatial.pan, frequency: event.weapon === "dual-turret" ? 540 : 1450, gain: 0.05 * spatial.gain, duration: 0.045});
  }
  return true;
}

const prototype = FreeRoamAudio?.prototype;
if (prototype && !prototype.__mediumCrewVesselPatchedV1) {
  prototype.__mediumCrewVesselPatchedV1 = true;
  const inheritedUpdateWorld = prototype.updateWorld;
  const inheritedHandleEvent = prototype.handleFreeEvent;

  prototype.updateWorld = function updateWorldWithMediumCrew(world, playerIndex) {
    const result = inheritedUpdateWorld.call(this, world, playerIndex);
    updateMediumCrewUi(world, playerIndex);
    return result;
  };

  prototype.handleFreeEvent = function handleFreeEventWithMediumCrew(event, playerIndex) {
    if (handleMediumShot(this, event, playerIndex)) return;
    return inheritedHandleEvent.call(this, event, playerIndex);
  };
}
