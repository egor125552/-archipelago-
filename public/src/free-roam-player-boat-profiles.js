"use strict";

const DEFAULT_ENGINE = "motorboatReal";
const DEFAULT_CONTROL_PROFILE = "player-boat";

function occupants(boat) {
  return [...new Set((boat?.crew || []).filter(Number.isInteger))];
}

function syncStations(boat) {
  if (!Array.isArray(boat?.turrets)) return;
  for (let index = 0; index < boat.turrets.length; index += 1) {
    boat.turrets[index].assignedPlayer = boat.crew?.[index] ?? null;
  }
}

function restorePersonalWeapon(player, boat) {
  const combat = player?.combat;
  if (!combat || !boat?.mountedWeaponId || combat.equipped !== boat.mountedWeaponId) return;
  combat.equipped = combat.weapons?.automatic ? "automatic" : "pistol";
}

export function ensurePlayerBoatProfiles(world) {
  for (const boat of world?.boats || []) {
    if (!boat) continue;
    boat.controlProfile ||= DEFAULT_CONTROL_PROFILE;
    boat.speechProfile ||= "standard";
    boat.audioProfile ||= "standard";
    boat.engineSound ||= DEFAULT_ENGINE;
    if (typeof boat.mountedWeaponId !== "string") boat.mountedWeaponId = null;
  }
  return world;
}

export function reconcilePlayerBoatTransitions(world) {
  ensurePlayerBoatProfiles(world);
  for (const boat of world?.boats || []) {
    if (!boat || !Array.isArray(boat.crew)) continue;
    for (const playerIndex of occupants(boat)) {
      const player = world.players?.[playerIndex];
      if (player?.mode === "boat" && player.activeBoat === boat.id) continue;
      boat.crew = boat.crew.map(value => value === playerIndex ? null : value);
      restorePersonalWeapon(player, boat);
    }
    const current = occupants(boat);
    if (!current.includes(boat.driver)) {
      boat.driver = current[0] ?? null;
      boat.throttle = 0;
      boat.rudder = 0;
      if (!Number.isInteger(boat.driver)) boat.speed = 0;
    }
    syncStations(boat);
  }
  return world;
}

function armoredText(boat, event) {
  const armor = Math.round(Number(boat.armor) || 0);
  const armorMax = Math.round(Number(boat.armorMax) || 0);
  const hull = Math.round(Number(boat.structuralHull) || 0);
  const hullMax = Math.round(Number(boat.maxStructuralHull) || 0);
  const seat = Number(event?.seat);
  const station = Number.isInteger(seat) ? boat.turrets?.[seat] : null;
  const stationText = station?.label ? ` Твоя установка: ${station.label}.` : "";

  switch (event?.type) {
    case "enter":
      return seat === 0
        ? `Ты занял место рулевого на бронекатере.${stationText} Броня ${armor} из ${armorMax}, корпус ${hull} из ${hullMax}.`
        : `Ты занял второе место на бронекатере.${stationText} Броня ${armor} из ${armorMax}, корпус ${hull} из ${hullMax}.`;
    case "exit":
      return event.text?.includes("берег")
        ? "Ты покинул бронекатер и вышел на берег."
        : "Ты покинул бронекатер и спрыгнул в воду.";
    case "player-boat-damaged":
      return `Бронекатер получил удар. Броня ${armor} из ${armorMax}, корпус ${hull} из ${hullMax}.`;
    case "pump-start": return "Насос бронекатера включён.";
    case "hull-repair-start": return "Установка ремонтной пластины на бронекатер началась.";
    case "hull-repair-progress": return `Ремонтная пластина: ${Math.round(Number(event.percent) || 0)} процентов.`;
    case "hull-repair-complete": return `Пластина установлена. Броня ${armor} из ${armorMax}, корпус ${hull} из ${hullMax}.`;
    case "repair-blocked": return "Пластину сейчас установить нельзя.";
    case "engine-stall": return "Двигатель бронекатера заглох.";
    case "engine-flooded": return "Двигатель бронекатера залит водой.";
    case "engine-water-restart": return "Двигатель бронекатера снова запущен.";
    default: return null;
  }
}

function eventBoat(world, event) {
  if (Number.isInteger(event?.boatId)) return world.boats?.[event.boatId] || null;
  if (Number.isInteger(event?.targetBoat)) return world.boats?.[event.targetBoat] || null;
  const playerIndex = Number(event?.sourcePlayer ?? event?.targets?.[0]);
  const player = world.players?.[playerIndex];
  if (Number.isInteger(player?.activeBoat)) return world.boats?.[player.activeBoat] || null;
  return null;
}

export function applyPlayerBoatSpeechProfiles(world, eventStart = 0) {
  ensurePlayerBoatProfiles(world);
  for (const event of (world?.events || []).slice(eventStart)) {
    const boat = eventBoat(world, event);
    if (!boat || boat.speechProfile !== "armored-patrol") continue;
    const text = armoredText(boat, event);
    if (text) event.text = text;
    const crew = occupants(boat);
    if (crew.length && [
      "pump-start",
      "hull-repair-start",
      "hull-repair-progress",
      "hull-repair-complete",
      "repair-blocked",
      "engine-water-restart",
      "engine-stall",
      "engine-flooded",
      "player-boat-damaged",
    ].includes(event.type)) event.targets = crew;
  }
  return world;
}
