"use strict";

import * as base from "./vessel-runtime.js?v=2";

export * from "./vessel-runtime.js?v=2";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const rad = value => Number(value) * Math.PI / 180;

const MOTION_DISRUPTION_EVENTS = new Set([
  "collision",
  "ram",
  "water-boundary",
  "tow-attach",
  "tow-detach",
  "sonar-guide-snap",
]);

function crewForBoat(boat) {
  const crew = Array.isArray(boat?.crew) ? boat.crew.filter(Number.isInteger) : [];
  if (Number.isInteger(boat?.driver) && !crew.includes(boat.driver)) crew.unshift(boat.driver);
  return crew;
}

function motionWasDisrupted(world, boat, eventStart = 0) {
  if (world?.tow && (world.tow.towerBoat === boat.id || world.tow.towedBoat === boat.id)) return true;
  const crew = new Set(crewForBoat(boat));
  return (world?.events || []).slice(eventStart).some(event => {
    if (!event || !MOTION_DISRUPTION_EVENTS.has(event.type)) return false;
    if (Number.isInteger(event.boatId) && event.boatId === boat.id) return true;
    if (Number.isInteger(event.targetBoat) && event.targetBoat === boat.id) return true;
    return (event.targets || []).some(target => crew.has(target));
  });
}

function syncOccupants(world, boat) {
  for (const player of world?.players || []) {
    if (!player || !["boat", "roof"].includes(player.mode) || player.activeBoat !== boat.id) continue;
    player.x = boat.x;
    player.y = boat.y;
    player.heading = boat.heading;
  }
}

function rebuildCleanLinearMotion(world, boat, before, safeDt) {
  const averageSpeed = ((Number(before.speed) || 0) + (Number(boat.speed) || 0)) * 0.5;
  const headingDelta = wrapDeg((Number(boat.heading) || 0) - (Number(before.heading) || 0));
  const averageHeading = wrapDeg((Number(before.heading) || 0) + headingDelta * 0.5);
  const radius = Math.max(1, Number(boat.collisionRadius) || 6);
  const width = Math.max(radius * 2, Number(world?.bounds?.width) || Number(world?.world?.width) || 420);
  const height = Math.max(radius * 2, Number(world?.bounds?.height) || Number(world?.world?.height) || 320);
  const shoreY = Number(world?.bounds?.shoreY) || Number(world?.world?.shoreY) || 72;
  boat.x = clamp((Number(before.x) || 0) + Math.sin(rad(averageHeading)) * averageSpeed * safeDt, radius, width - radius);
  boat.y = clamp((Number(before.y) || 0) - Math.cos(rad(averageHeading)) * averageSpeed * safeDt, shoreY + 4, height - radius);
  syncOccupants(world, boat);
}

function modulePhysicsEntries(world) {
  return base.listNativeVessels(world).filter(entry => entry?.definition?.physics?.mode === "module");
}

export function prepareVesselModuleMotionAuthority({world, boat, before, dt, eventStart = 0} = {}) {
  const safeDt = clamp(dt, 0, 0.1);
  if (!boat || !before || safeDt <= 0 || motionWasDisrupted(world, boat, eventStart)) return null;

  const token = {
    before,
    safeDt,
    eventStart: Math.max(0, Math.floor(Number(eventStart) || 0)),
    legacyX: Number(boat.x) || 0,
    legacyY: Number(boat.y) || 0,
  };

  // Legacy free-roam still runs first for compatibility with old collisions,
  // steering and interactions. A module-driven architectural vessel owns its
  // propulsion result, so the legacy speed from this same tick is not allowed
  // to become a second speed authority.
  boat.speed = Number(before.speed) || 0;
  return token;
}

export function finishVesselModuleMotionAuthority({world, boat, token} = {}) {
  if (!boat || !token) return false;

  // A real contact/tow/boundary event always wins. Recheck after the module as
  // well, because a future physics module may itself emit a physical event.
  if (motionWasDisrupted(world, boat, token.eventStart)) return false;

  // Full custom physics modules are allowed to integrate their own position.
  // Only speed-only modules need the shared runtime to replace the stale
  // legacy displacement with movement based on the module's final speed.
  const moduleMoved = Math.abs((Number(boat.x) || 0) - token.legacyX) > 1e-9
    || Math.abs((Number(boat.y) || 0) - token.legacyY) > 1e-9;
  if (moduleMoved) return false;

  rebuildCleanLinearMotion(world, boat, token.before, token.safeDt);
  return true;
}

export function runVesselPhysics(context = {}) {
  const world = context.world;
  if (!world) return world;

  const cleanMotion = new Map();
  for (const entry of modulePhysicsEntries(world)) {
    const boat = entry.boat;
    const token = prepareVesselModuleMotionAuthority({
      world,
      boat,
      before: context.previousStates?.[boat?.id] || null,
      dt: context.dt,
      eventStart: context.eventStart,
    });
    if (token) cleanMotion.set(boat.id, token);
  }

  base.runVesselPhysics(context);

  for (const entry of modulePhysicsEntries(world)) {
    const boat = entry.boat;
    finishVesselModuleMotionAuthority({world, boat, token: cleanMotion.get(boat?.id)});
  }

  return world;
}
