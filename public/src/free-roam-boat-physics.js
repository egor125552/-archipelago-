"use strict";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;
const rad = value => Number(value) * Math.PI / 180;

function positive(value, fallback) {
  const numeric = Math.abs(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function resolveBoatPhysicsProfile(boat, tuning = {}) {
  const profile = boat?.physicsProfile && typeof boat.physicsProfile === "object"
    ? boat.physicsProfile
    : {};
  const engineLevel = clamp(Math.floor(Number(boat?.engineUpgradeLevel) || 0), 0, 3);
  const forwardUpgrade = 1 + engineLevel * 0.12;
  const reverseUpgrade = 1 + engineLevel * 0.08;
  const baseForward = positive(tuning.maxSpeed, 21);
  const baseReverse = positive(tuning.reverseSpeed, 6);
  const baseAcceleration = positive(tuning.acceleration, 8.4);
  const baseDrag = positive(tuning.drag, 0.09);

  return Object.freeze({
    id: String(profile.id || "standard"),
    maxForwardSpeed: positive(profile.maxForwardSpeed, baseForward) * forwardUpgrade,
    maxReverseSpeed: positive(profile.maxReverseSpeed, baseReverse) * reverseUpgrade,
    acceleration: baseAcceleration * clamp(profile.accelerationFactor ?? 1, 0.2, 2.5),
    accelerationFactor: clamp(profile.accelerationFactor ?? 1, 0.2, 2.5),
    turnFactor: clamp(profile.turnFactor ?? 1, 0.2, 2.5),
    rudderResponseFactor: clamp(profile.rudderResponseFactor ?? 1, 0.2, 2.5),
    drag: baseDrag * clamp(profile.dragFactor ?? 1, 0.3, 2.5),
    dragFactor: clamp(profile.dragFactor ?? 1, 0.3, 2.5),
  });
}

export function captureBoatPhysicsState(world) {
  return (world?.boats || []).map(boat => boat ? {
    x: Number(boat.x) || 0,
    y: Number(boat.y) || 0,
    heading: Number(boat.heading) || 0,
    speed: Number(boat.speed) || 0,
    rudder: Number(boat.rudder) || 0,
  } : null);
}

function crewForBoat(boat) {
  const crew = Array.isArray(boat?.crew) ? boat.crew.filter(Number.isInteger) : [];
  if (Number.isInteger(boat?.driver) && !crew.includes(boat.driver)) crew.unshift(boat.driver);
  return crew;
}

function disruptiveForBoat(world, boat, eventStart) {
  if (world?.tow && (world.tow.towerBoat === boat.id || world.tow.towedBoat === boat.id)) return true;
  const crew = new Set(crewForBoat(boat));
  return (world?.events || []).slice(eventStart).some(event => {
    if (!event || !["collision", "ram", "water-boundary", "tow-attach", "tow-detach"].includes(event.type)) return false;
    if (Number.isInteger(event.boatId)) return event.boatId === boat.id;
    if (Number.isInteger(event.targetBoat)) return event.targetBoat === boat.id;
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

export function applyBoatPhysicsProfiles(world, previousStates, dt, {tuning = {}, eventStart = 0} = {}) {
  const safeDt = clamp(dt, 0, 0.1);
  if (!world || safeDt <= 0) return world;

  for (let index = 0; index < (world.boats || []).length; index += 1) {
    const boat = world.boats[index];
    const before = previousStates?.[index];
    if (!boat || !before || boat.sunk || boat.reserved || !boat.physicsProfile) continue;

    const physics = resolveBoatPhysicsProfile(boat, tuning);
    boat.speed = clamp(Number(boat.speed) || 0, -physics.maxReverseSpeed, physics.maxForwardSpeed);
    if (disruptiveForBoat(world, boat, eventStart)) {
      syncOccupants(world, boat);
      continue;
    }

    const baseSpeed = boat.speed;
    const speedDelta = baseSpeed - before.speed;
    const changingDirection = Math.sign(baseSpeed) !== Math.sign(before.speed) && Math.abs(before.speed) > 0.05;
    const speedFactor = speedDelta >= 0 || changingDirection
      ? physics.accelerationFactor
      : Math.min(1, 0.72 + physics.dragFactor * 0.28);
    boat.speed = clamp(before.speed + speedDelta * speedFactor, -physics.maxReverseSpeed, physics.maxForwardSpeed);

    const headingDelta = wrapDeg((Number(boat.heading) || 0) - before.heading);
    boat.heading = wrapDeg(before.heading + headingDelta * physics.turnFactor);
    boat.rudder = before.rudder + ((Number(boat.rudder) || 0) - before.rudder) * physics.rudderResponseFactor;

    const averageSpeed = (before.speed + boat.speed) * 0.5;
    const averageHeading = wrapDeg(before.heading + wrapDeg(boat.heading - before.heading) * 0.5);
    const radius = Math.max(1, Number(boat.collisionRadius) || 6);
    const width = Math.max(radius * 2, Number(world?.bounds?.width) || Number(world?.world?.width) || 420);
    const height = Math.max(radius * 2, Number(world?.bounds?.height) || Number(world?.world?.height) || 320);
    const shoreY = Number(world?.bounds?.shoreY) || Number(world?.world?.shoreY) || 72;
    boat.x = clamp(before.x + Math.sin(rad(averageHeading)) * averageSpeed * safeDt, radius, width - radius);
    boat.y = clamp(before.y - Math.cos(rad(averageHeading)) * averageSpeed * safeDt, shoreY + 4, height - radius);
    syncOccupants(world, boat);
  }
  return world;
}
