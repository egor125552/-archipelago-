"use strict";

const RESPAWN_LABEL = "Возродиться";
const RESPAWN_PULSE_MS = 140;
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

function pulseRespawn() {
  const api = freeRoamApi();
  if (!api?.setControl || !playerIsDead()) return false;
  api.setControl("action", true);
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = 0;
    freeRoamApi()?.setControl?.("action", false);
  }, RESPAWN_PULSE_MS);
  return true;
}

function ensureRespawnButton() {
  const actionButton = document.getElementById("actionButton");
  if (!actionButton) return null;
  let button = document.getElementById("respawnButton");
  if (button) return button;

  button = document.createElement("button");
  button.id = "respawnButton";
  button.type = "button";
  button.className = actionButton.className;
  button.textContent = RESPAWN_LABEL;
  button.setAttribute("aria-label", "Возродиться");
  button.setAttribute("aria-keyshortcuts", "R");
  button.hidden = true;
  button.addEventListener("click", event => {
    if (!pulseRespawn()) return;
    event.preventDefault();
  });
  actionButton.insertAdjacentElement("beforebegin", button);
  return button;
}

function syncRespawnControls() {
  const button = ensureRespawnButton();
  const actionButton = document.getElementById("actionButton");
  if (!button || !actionButton) return;
  const dead = playerIsDead();
  button.hidden = !dead;
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
  if (!pulseRespawn()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function installManualRespawnControls() {
  ensureRespawnButton();
  syncRespawnControls();
  window.addEventListener("keydown", handleRespawnKey, true);
  window.addEventListener("blur", () => {
    clearTimeout(releaseTimer);
    releaseTimer = 0;
    freeRoamApi()?.setControl?.("action", false);
  });
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
