"use strict";

const EVENT_NAME = "free-roam-mega-bomb-message";
const PATCH_FLAG = Symbol.for("echo.freeRoam.megaBombImpactSpatialV1");
const DEFAULT_IMPACT_MS = 12000;
const LAND = Object.freeze({minX: 118, maxX: 302, minY: 8, maxY: 76});
const impacts = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const values = value => Array.isArray(value)
  ? value
  : value && typeof value === "object" ? Object.values(value) : [];
const wrap = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

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

function segmentCrossesRect(from, to, rect = LAND) {
  const x1 = Number(from?.x);
  const y1 = Number(from?.y);
  const x2 = Number(to?.x);
  const y2 = Number(to?.y);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return false;

  const inside = point => point.x > rect.minX && point.x < rect.maxX
    && point.y > rect.minY && point.y < rect.maxY;
  if (inside({x: x1, y: y1}) && inside({x: x2, y: y2})) return false;

  let enter = 0;
  let exit = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const checks = [
    [-dx, x1 - rect.minX],
    [dx, rect.maxX - x1],
    [-dy, y1 - rect.minY],
    [dy, rect.maxY - y1],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) enter = Math.max(enter, ratio);
    else exit = Math.min(exit, ratio);
    if (enter > exit) return false;
  }
  return exit > 0.001 && enter < 0.999;
}

export function impactSpatialStateV1(world, playerIndex, impact) {
  if (!impact || world?.freeActivities?.presence?.[playerIndex] === false) return null;
  const listener = listenerPoint(world, playerIndex);
  if (!listener) return null;
  const dx = (Number(impact.x) || 0) - (Number(listener.x) || 0);
  const dy = (Number(impact.y) || 0) - (Number(listener.y) || 0);
  const horizontal = Math.hypot(dx, dy);
  const metres = Math.hypot(horizontal, Math.max(0, Number(impact.z) || 0));
  const relative = wrap(bearing(listener, impact) - (Number(listener.heading) || 0));
  return {
    pan: clamp(Math.sin(relative * Math.PI / 180), -1, 1),
    gain: clamp(Math.pow(1 + metres / 48, -1.72), 0, 1),
    distance: Math.round(metres * 10) / 10,
    listenerX: Number(listener.x) || 0,
    listenerY: Number(listener.y) || 0,
    listenerHeading: Number(listener.heading) || 0,
    radialSpeed: 0,
    speed: 0,
    elevation: Math.atan2(Math.max(0, Number(impact.z) || 0), Math.max(0.1, horizontal)) * 180 / Math.PI,
    occluded: segmentCrossesRect(impact, listener),
    surface: impact.surface || "water",
  };
}

function rememberExplosion(event) {
  const id = String(event?.projectileId || "");
  if (!id) return;
  const now = performance.now();
  impacts.set(id, {
    projectileId: id,
    sourcePlayer: event.sourcePlayer,
    x: Number(event.x) || 0,
    y: Number(event.y) || 0,
    z: Math.max(0, Number(event.z) || 0),
    surface: event.surface || "water",
    reason: event.reason || "impact",
    startedAt: now,
    expiresAt: now + DEFAULT_IMPACT_MS,
  });
}

function publishLocalImpactUpdates(world, playerIndex) {
  if (typeof globalThis.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  const now = performance.now();
  const events = [];
  for (const [id, impact] of impacts) {
    if (impact.expiresAt <= now) {
      impacts.delete(id);
      continue;
    }
    const state = impactSpatialStateV1(world, playerIndex, impact);
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
      age: Math.max(0, (now - impact.startedAt) / 1000),
      duration: DEFAULT_IMPACT_MS / 1000,
      spatial,
      localPresentationOnly: true,
    });
  }
  if (!events.length) return;
  globalThis.dispatchEvent(new CustomEvent(EVENT_NAME, {
    detail: {type: "free-state", events, localPresentationOnly: true},
  }));
}

function install() {
  if (typeof globalThis.addEventListener !== "function" || globalThis[PATCH_FLAG]) return;
  globalThis[PATCH_FLAG] = true;

  globalThis.addEventListener(EVENT_NAME, event => {
    const message = event?.detail;
    if (!message || typeof message !== "object") return;
    if (message.type === "lobby-ready" || message.type === "network-closed") {
      impacts.clear();
      return;
    }
    if (message.type !== "free-state" || !Array.isArray(message.events)) return;
    for (const gameEvent of message.events) {
      if (gameEvent?.type === "mega-bomb-explosion") rememberExplosion(gameEvent);
    }
  });

  const installAudioPatch = () => {
    const prototype = globalThis.__freeRoamAudioEngine?.constructor?.prototype;
    if (!prototype || prototype[PATCH_FLAG] || typeof prototype.updateWorld !== "function") return false;
    Object.defineProperty(prototype, PATCH_FLAG, {value: true});
    const originalUpdateWorld = prototype.updateWorld;
    prototype.updateWorld = function impactSpatialUpdateWorld(world, playerIndex, ...rest) {
      const result = originalUpdateWorld.call(this, world, playerIndex, ...rest);
      publishLocalImpactUpdates(world, playerIndex);
      return result;
    };
    return true;
  };

  globalThis.addEventListener("free-roam-audio-graph-ready", installAudioPatch);
  installAudioPatch();
}

install();
