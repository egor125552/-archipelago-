"use strict";

const RESPAWN_PULSE_MS = 120;
let releaseTimer = 0;

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

function ensureRespawnControl(api) {
  if (!api?.input || typeof api.setControl !== "function") return false;
  if (!("respawn" in api.input)) api.input.respawn = false;
  return true;
}

function requestRespawn() {
  if (!playerIsDead()) return false;
  const api = freeRoamApi();
  if (!ensureRespawnControl(api)) return false;
  clearTimeout(releaseTimer);
  api.setControl("respawn", true);
  releaseTimer = setTimeout(() => api.setControl("respawn", false), RESPAWN_PULSE_MS);
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
  if (!requestRespawn()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function installManualRespawnControls() {
  const respawnButton = document.getElementById("respawnButton");
  if (!respawnButton) return;
  respawnButton.addEventListener("click", event => {
    if (!requestRespawn()) return;
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
