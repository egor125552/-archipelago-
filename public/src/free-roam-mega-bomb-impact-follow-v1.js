"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const AUDIO_GRAPH_EVENT = "free-roam-audio-graph-ready";
const PATCH_FLAG = Symbol.for("echo.freeRoam.megaBombImpactFollowV1");
const UPDATE_MS = 50;
const DEFAULT_DURATION = 10.6;

const impacts = new Map();
let localPlayerIndex = 0;
let lastPublishedAt = 0;

const nowMs = () => globalThis.performance?.now?.() ?? Date.now();
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const values = value => Array.isArray(value)
  ? value
  : value && typeof value === "object" ? Object.values(value) : [];
const wrap = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;

function listenerPoint(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) {
    return values(world?.boats).find(boat => String(boat?.id) === String(player.activeBoat))
      || world?.boats?.[player.activeBoat]
      || null;
  }
  return player;
}

export function localImpactSpatialV1(world, playerIndex, impact) {
  const listener = listenerPoint(world, playerIndex);
  if (!listener || world?.freeActivities?.presence?.[playerIndex] === false) return null;

  const dx = (Number(impact?.x) || 0) - (Number(listener.x) || 0);
  const dy = (Number(impact?.y) || 0) - (Number(listener.y) || 0);
  const z = Math.max(0, Number(impact?.z) || 0);
  const horizontal = Math.hypot(dx, dy);
  const distance = Math.hypot(horizontal, z);
  const absoluteBearing = Math.atan2(dx, -dy) * 180 / Math.PI;
  const relative = wrap(absoluteBearing - (Number(listener.heading) || 0));
  const initial = impact?.spatial?.[playerIndex] || {};

  return {
    pan: clamp(Math.sin(relative * Math.PI / 180), -1, 1),
    gain: clamp(Math.pow(1 + distance / 48, -1.72), 0, 1),
    distance: Math.round(distance * 10) / 10,
    listenerX: Number(listener.x) || 0,
    listenerY: Number(listener.y) || 0,
    listenerHeading: Number(listener.heading) || 0,
    radialSpeed: 0,
    speed: 0,
    elevation: Math.atan2(z, Math.max(0.1, horizontal)) * 180 / Math.PI,
    occluded: Boolean(initial.occluded),
    surface: impact?.surface || initial.surface || "water",
  };
}

function rememberExplosion(event) {
  const id = String(event?.projectileId || "");
  if (!id || impacts.has(id)) return;
  const duration = clamp(event.duration || DEFAULT_DURATION, 0.5, 20);
  const startedAt = nowMs();
  impacts.set(id, {
    projectileId: id,
    sourcePlayer: event.sourcePlayer,
    x: Number(event.x) || 0,
    y: Number(event.y) || 0,
    z: Math.max(0, Number(event.z) || 0),
    surface: event.surface || "water",
    reason: event.reason || "impact",
    spatial: event.spatial,
    duration,
    startedAt,
    expiresAt: startedAt + duration * 1000,
  });
}

function publishLocalUpdates(world, playerIndex) {
  if (typeof globalThis.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  const current = nowMs();
  if (current - lastPublishedAt < UPDATE_MS) return;
  lastPublishedAt = current;

  const events = [];
  for (const [id, impact] of impacts) {
    if (impact.expiresAt <= current) {
      impacts.delete(id);
      continue;
    }
    const state = localImpactSpatialV1(world, playerIndex, impact);
    if (!state) continue;
    const spatial = [];
    spatial[playerIndex] = state;
    events.push({
      type: "mega-bomb-explosion-spatial",
      text: "",
      targets: [playerIndex],
      sourcePlayer: impact.sourcePlayer,
      projectileId: id,
      x: impact.x,
      y: impact.y,
      z: impact.z,
      surface: impact.surface,
      reason: impact.reason,
      age: Math.max(0, (current - impact.startedAt) / 1000),
      duration: impact.duration,
      spatial,
      localPresentationOnly: true,
    });
  }
  if (!events.length) return;
  globalThis.dispatchEvent(new CustomEvent(EVENT_NAME, {
    detail: {type: "free-state", events, localPresentationOnly: true},
  }));
}

function installAudioPatch() {
  const prototype = globalThis.__freeRoamAudioEngine?.constructor?.prototype;
  if (!prototype || prototype[PATCH_FLAG] || typeof prototype.updateWorld !== "function") return false;
  Object.defineProperty(prototype, PATCH_FLAG, {value: true});
  const originalUpdateWorld = prototype.updateWorld;
  prototype.updateWorld = function megaBombImpactFollowUpdateWorld(world, playerIndex, ...rest) {
    const result = originalUpdateWorld.call(this, world, playerIndex, ...rest);
    publishLocalUpdates(world, Number.isInteger(playerIndex) ? playerIndex : localPlayerIndex);
    return result;
  };
  return true;
}

function install() {
  if (typeof globalThis.addEventListener !== "function" || globalThis[PATCH_FLAG]) return;
  globalThis[PATCH_FLAG] = true;

  globalThis.addEventListener(EVENT_NAME, event => {
    const message = event?.detail;
    if (!message || typeof message !== "object") return;
    if (message.type === "lobby-ready") {
      impacts.clear();
      localPlayerIndex = message.role === "crew" ? 1 : 0;
      return;
    }
    if (message.type === "network-closed") {
      impacts.clear();
      return;
    }
    if (message.localPresentationOnly || message.type !== "free-state" || !Array.isArray(message.events)) return;
    for (const gameEvent of message.events) {
      if (gameEvent?.type === "mega-bomb-explosion" && gameEvent?.targets?.includes(localPlayerIndex)) {
        rememberExplosion(gameEvent);
      }
    }
  });

  globalThis.addEventListener(AUDIO_GRAPH_EVENT, installAudioPatch);
  installAudioPatch();
}

install();
