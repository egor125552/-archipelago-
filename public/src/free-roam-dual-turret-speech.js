"use strict";

const PATROL_TYPE = "dual-turret-patrol";

function crew(boat) {
  return [...new Set((boat?.crew || []).filter(Number.isInteger))];
}

function eventBoat(world, event) {
  if (Number.isInteger(event?.boatId)) return world.boats?.[event.boatId] || null;
  if (Number.isInteger(event?.targetBoat)) return world.boats?.[event.targetBoat] || null;
  for (const playerIndex of event?.targets || []) {
    const player = world.players?.[playerIndex];
    if (Number.isInteger(player?.activeBoat)) {
      const boat = world.boats?.[player.activeBoat];
      if (boat?.boatType === PATROL_TYPE) return boat;
    }
  }
  return null;
}

function status(boat) {
  return `корпус ${Math.round(Number(boat.hull) || 0)} из ${Math.round(Number(boat.hullMax) || 300)}, броня ${Math.round(Number(boat.armor) || 0)} из ${Math.round(Number(boat.armorMax) || 200)}`;
}

function patrolText(boat, event) {
  const seat = Number(event?.seat);
  switch (event?.type) {
    case "enter":
      return seat === 1
        ? `Ты занял второе место на бронекатере. ${status(boat)}.`
        : `Ты занял место рулевого на бронекатере. ${status(boat)}.`;
    case "exit":
      return event.text?.includes("берег")
        ? "Ты покинул бронекатер и вышел на берег."
        : "Ты покинул бронекатер и спрыгнул в воду.";
    case "pump-start": return "Насос бронекатера включён.";
    case "hull-repair-start": return "Установка ремонтной пластины на бронекатер началась.";
    case "hull-repair-progress": return `Ремонтная пластина: ${Math.round(Number(event.percent) || 0)} процентов.`;
    case "hull-repair-complete": return `Пластина закреплена. ${status(boat)}. Пластин осталось ${Math.max(0, Math.floor(Number(boat.repairPatches) || 0))}.`;
    case "repair-blocked": return `Бронекатер: ${event.text || "пластину сейчас установить нельзя."}`;
    case "player-boat-damaged": return `Бронекатер получил повреждение. ${status(boat)}.`;
    case "engine-stall": return "Тяжёлый двигатель бронекатера заглох.";
    case "engine-flooded": return "Тяжёлый двигатель бронекатера залит водой.";
    case "engine-water-restart": return "Тяжёлый двигатель бронекатера снова запущен.";
    case "flood-emergency-start": return `Авария бронекатера. ${status(boat)}. Нужны насос и ремонтная пластина.`;
    case "flood-emergency-recovered": return `Бронекатер стабилизирован. ${status(boat)}.`;
    default: return null;
  }
}

export function attachPatrolExitBoatIds(world, eventStart, previousBoatIds) {
  const fresh = (world?.events || []).slice(eventStart);
  for (const event of fresh) {
    if (event?.type !== "exit" || Number.isInteger(event.boatId)) continue;
    const playerIndex = Number(event.sourcePlayer ?? event.targets?.[0]);
    const boatId = previousBoatIds?.[playerIndex];
    const boat = Number.isInteger(boatId) ? world.boats?.[boatId] : null;
    if (boat?.boatType === PATROL_TYPE) event.boatId = boatId;
  }
}

export function applyDualTurretSpeech(world, eventStart = 0) {
  for (const event of (world?.events || []).slice(eventStart)) {
    const boat = eventBoat(world, event);
    if (boat?.boatType !== PATROL_TYPE) continue;
    const text = patrolText(boat, event);
    if (text) event.text = text;
    const targets = crew(boat);
    if (targets.length && [
      "pump-start",
      "hull-repair-start",
      "hull-repair-progress",
      "hull-repair-complete",
      "repair-blocked",
      "player-boat-damaged",
      "engine-stall",
      "engine-flooded",
      "engine-water-restart",
      "flood-emergency-start",
      "flood-emergency-recovered",
    ].includes(event.type)) event.targets = targets;
  }
  return world;
}
