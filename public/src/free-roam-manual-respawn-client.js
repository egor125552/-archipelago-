"use strict";

function freeRoamApi() {
  return globalThis.__freeRoam || null;
}

function playerIsDead() {
  const api = freeRoamApi();
  const world = api?.getWorld?.();
  const index = api?.playerIndex?.();
  const player = world?.players?.[index];
  return Boolean(player && (player.mode === "dead" || player.combat?.alive === false));
}

function triggerRespawn() {
  if (!playerIsDead()) return false;
  const actionButton = document.getElementById("actionButton");
  if (!actionButton) return false;
  actionButton.click();
  return true;
}

function syncRespawnControls() {
  const game = document.getElementById("game");
  const actionButton = document.getElementById("actionButton");
  const respawnButton = document.getElementById("respawnButton");
  if (!actionButton || !respawnButton) return;
  const dead = !game?.hidden && playerIsDead();
  respawnButton.hidden = !dead;
  respawnButton.disabled = false;
  actionButton.hidden = dead;
}

function handleRespawnKey(event) {
  if (
    event.repeat
    || event.code !== "KeyR"
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.isComposing
    || event.target?.matches?.("input, textarea, select, [contenteditable='true']")
  ) return;
  if (!triggerRespawn()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function installManualRespawnControls() {
  const respawnButton = document.getElementById("respawnButton");
  if (!respawnButton) return;
  respawnButton.addEventListener("click", event => {
    if (!triggerRespawn()) return;
    event.preventDefault();
  });
  window.addEventListener("keydown", handleRespawnKey, true);
  syncRespawnControls();
  setInterval(() => {
    if (!document.hidden) syncRespawnControls();
  }, 250);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installManualRespawnControls, {once: true});
  } else {
    installManualRespawnControls();
  }
}
