"use strict";

export function updateDualTurretUi(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  const boat = player?.mode === "boat" ? world.boats?.[player.activeBoat] : null;
  if (boat?.boatType === "dual-turret-patrol") {
    const hull = document.getElementById("hullValue");
    if (hull) hull.textContent = `${Math.round(boat.hull || 0)} из ${Math.round(boat.hullMax || 300)}; броня ${Math.round(boat.armor || 0)}`;
  }
  if (player?.combat?.equipped !== "dual-turret") return;
  const turret = boat?.turrets?.find(candidate => candidate.assignedPlayer === playerIndex);
  const label = turret?.label || "бортовая установка";
  const weaponValue = document.getElementById("weaponValue");
  const weaponButton = document.getElementById("weaponButton");
  const attackButton = document.getElementById("attackButton");
  if (weaponValue) weaponValue.textContent = `${label}, ${Math.max(0, Math.floor(Number(turret?.ammo) || 0))}`;
  if (weaponButton) weaponButton.textContent = `Оружие: ${label}`;
  if (attackButton) attackButton.textContent = "Огонь установки";
}
