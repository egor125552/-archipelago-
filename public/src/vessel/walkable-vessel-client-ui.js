"use strict";

const byId = id => document.getElementById(id);

function currentDeckContext() {
  const api = globalThis.__freeRoam;
  const world = api?.getWorld?.();
  const playerIndex = api?.playerIndex?.();
  if (!world || !Number.isInteger(playerIndex)) return null;
  const player = world.players?.[playerIndex];
  if (!player || player.mode !== "boat" || !Number.isInteger(player.activeBoat)) return null;
  const vessel = (world.vesselArchitecture?.vessels || []).find(candidate => candidate?.legacyBoatId === player.activeBoat);
  const occupant = vessel?.occupants?.[playerIndex] || vessel?.occupants?.[String(playerIndex)] || null;
  if (!occupant) return null;
  const boat = world.boats?.[player.activeBoat] || null;
  return {world, playerIndex, player, boat, vessel, occupant, controlling: boat?.driver === playerIndex};
}

function setLabel(id, text) {
  const node = byId(id);
  if (!node || node.textContent === text) return;
  node.textContent = text;
  node.setAttribute("aria-label", text);
}

function syncWalkableVesselPresentation() {
  const context = currentDeckContext();
  if (!context) return;
  if (context.controlling) {
    if (byId("modeValue")) byId("modeValue").textContent = "у пульта управления";
    setLabel("actionButton", "Отойти от пульта / действие");
    setLabel("jumpButton", "Плавучий тормоз");
    setLabel("upButton", "Вперёд");
    setLabel("downButton", "Назад / тормоз");
    setLabel("leftButton", "Влево");
    setLabel("rightButton", "Вправо");
    return;
  }
  if (byId("modeValue")) byId("modeValue").textContent = "на палубе";
  setLabel("actionButton", "Действие на палубе");
  setLabel("jumpButton", "Прыжок / спрыгнуть");
  setLabel("upButton", "Вперёд по палубе");
  setLabel("downButton", "Назад по палубе");
  setLabel("leftButton", "Влево по палубе");
  setLabel("rightButton", "Вправо по палубе");
}

const observed = ["controls", "modeValue", "message"].map(byId).filter(Boolean);
if (typeof MutationObserver === "function") {
  const observer = new MutationObserver(syncWalkableVesselPresentation);
  for (const node of observed) observer.observe(node, {childList: true, subtree: true, characterData: true});
}

syncWalkableVesselPresentation();

globalThis.__walkableVesselClientUI = Object.freeze({sync: syncWalkableVesselPresentation, context: currentDeckContext});
