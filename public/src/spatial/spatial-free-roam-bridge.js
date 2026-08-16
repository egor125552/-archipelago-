"use strict";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const distance2d = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const wrapDegrees = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: Number(world.time) || 0, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function endpointMatches(player, endpoint) {
  const locationId = player?.spatialLocationId || null;
  const spaceId = player?.spatialSpaceId || null;
  return locationId === (endpoint.locationId || null) && spaceId === (endpoint.spaceId || null);
}

function bindingSpace(binding, spaceId) {
  return (binding?.spaces || []).find(space => space.id === spaceId) || null;
}

function endpointFloor(binding, endpoint) {
  if (Number.isFinite(endpoint?.floorZ)) return Number(endpoint.floorZ);
  return Number(bindingSpace(binding, endpoint?.spaceId)?.floorZ) || 0;
}

function ensurePlayerSpatialState(player) {
  if (!player) return;
  if (!("spatialLocationId" in player)) player.spatialLocationId = null;
  if (!("spatialSpaceId" in player)) player.spatialSpaceId = null;
  if (!Number.isFinite(player.spatialFloorZ)) player.spatialFloorZ = 0;
  if (!Number.isFinite(player.z)) player.z = player.spatialFloorZ + Math.max(0, Number(player.jumpHeight) || 0);
}

function ensureBridgeState(world) {
  if (!world) return null;
  const count = world.players?.length || 0;
  world.freeSpatialBridge ||= {
    gatewayHeld: Array.from({length: count}, () => false),
    boundaryAt: Array.from({length: count}, () => -999),
    proximityNear: Array.from({length: count}, () => false),
  };
  const state = world.freeSpatialBridge;
  state.gatewayHeld ||= [];
  state.boundaryAt ||= [];
  state.proximityNear ||= [];
  while (state.gatewayHeld.length < count) state.gatewayHeld.push(false);
  while (state.boundaryAt.length < count) state.boundaryAt.push(-999);
  while (state.proximityNear.length < count) state.proximityNear.push(false);
  for (const player of world.players || []) ensurePlayerSpatialState(player);
  return state;
}

function applyEndpoint(player, binding, endpoint) {
  player.mode = "foot";
  player.activeBoat = null;
  player.x = Number(endpoint.position?.x) || 0;
  player.y = Number(endpoint.position?.y) || 0;
  if (Number.isFinite(endpoint.heading)) player.heading = Number(endpoint.heading);
  player.spatialLocationId = endpoint.locationId || null;
  player.spatialSpaceId = endpoint.spaceId || null;
  player.spatialFloorZ = endpointFloor(binding, endpoint);
  player.airborne = false;
  player.jumpHeight = 0;
  player.jumpVelocity = 0;
  player.z = player.spatialFloorZ;
}

function passageCandidate(player, passage) {
  const sides = [
    {here: passage.from, there: passage.to, reverse: false},
    ...(passage.bidirectional === false ? [] : [{here: passage.to, there: passage.from, reverse: true}]),
  ];
  let best = null;
  for (const side of sides) {
    if (!endpointMatches(player, side.here)) continue;
    const metres = distance2d(player, side.here.position);
    const radius = Math.max(0.5, Number(side.here.radius ?? passage.radius) || 3);
    if (metres > radius) continue;
    if (!best || metres < best.metres) best = {...side, metres};
  }
  return best;
}

function destinationLabel(binding, endpoint) {
  if (!endpoint.locationId) return binding.outsideLabel || "берег";
  return bindingSpace(binding, endpoint.spaceId)?.label || binding.label || endpoint.spaceId;
}

function useNearestPassage(world, playerIndex, binding) {
  const player = world.players?.[playerIndex];
  if (!player || player.mode !== "foot" || player.airborne) return false;
  let selected = null;
  for (const passage of binding.passages || []) {
    const candidate = passageCandidate(player, passage);
    if (!candidate) continue;
    if (!selected || candidate.metres < selected.candidate.metres) selected = {passage, candidate};
  }
  if (!selected) return false;

  const {passage, candidate} = selected;
  const leavingLocation = Boolean(candidate.here.locationId && !candidate.there.locationId);
  const enteringLocation = Boolean(!candidate.here.locationId && candidate.there.locationId);
  applyEndpoint(player, binding, candidate.there);

  const targetLabel = destinationLabel(binding, candidate.there);
  const text = enteringLocation
    ? `Ты вошёл в ${binding.label}. ${targetLabel}. Высота ${Math.round(player.z * 10) / 10} метра.`
    : leavingLocation
      ? `Ты вышел из ${binding.label} на ${targetLabel}.`
      : `Ты прошёл: ${passage.label}. ${targetLabel}. Высота ${Math.round(player.z * 10) / 10} метра.`;
  emit(world, enteringLocation ? "location-enter" : leavingLocation ? "location-exit" : "location-passage", text, [playerIndex], {
    sourcePlayer: playerIndex,
    passageId: passage.id,
    locationId: player.spatialLocationId,
    spaceId: player.spatialSpaceId,
    x: player.x,
    y: player.y,
    z: player.z,
  });
  return true;
}

function clampToCurrentSpace(world, playerIndex, player, binding, state) {
  if (!player?.spatialLocationId || player.spatialLocationId !== binding.id) return;
  const space = bindingSpace(binding, player.spatialSpaceId);
  if (!space?.bounds || player.mode !== "foot") return;
  const oldX = player.x;
  const oldY = player.y;
  player.x = clamp(player.x, space.bounds.minX, space.bounds.maxX);
  player.y = clamp(player.y, space.bounds.minY, space.bounds.maxY);
  if (oldX === player.x && oldY === player.y) return;
  const now = Number(world.time) || 0;
  if (now - state.boundaryAt[playerIndex] < 0.8) return;
  state.boundaryAt[playerIndex] = now;
  emit(world, "location-boundary", `Граница: ${space.label}. Дальше прохода нет.`, [playerIndex], {
    sourcePlayer: playerIndex,
    locationId: binding.id,
    spaceId: space.id,
    x: player.x,
    y: player.y,
    z: player.z,
  });
}

function announceNearbyEntrance(world, playerIndex, player, binding, state) {
  if (player?.mode !== "foot" || player.spatialLocationId) return;
  const entrance = (binding.passages || []).find(passage => !passage.from?.locationId && passage.to?.locationId === binding.id)?.from;
  if (!entrance) return;
  const metres = distance2d(player, entrance.position);
  const discoverRadius = Math.max(Number(entrance.discoverRadius) || 0, Number(entrance.radius) || 3);
  const near = Boolean(discoverRadius && metres <= discoverRadius);
  if (!near) {
    state.proximityNear[playerIndex] = false;
    return;
  }
  if (state.proximityNear[playerIndex]) return;
  state.proximityNear[playerIndex] = true;
  emit(world, "location-nearby", `Рядом вход в ${binding.label}, примерно ${Math.max(1, Math.round(metres))} метров. Подойди и нажми действие.`, [playerIndex], {
    sourcePlayer: playerIndex,
    locationId: binding.id,
    x: entrance.position.x,
    y: entrance.position.y,
    z: entrance.position.z || 0,
    distance: metres,
  });
}

export function initializeFreeRoamSpatialBridge(world, binding) {
  const state = ensureBridgeState(world);
  if (!state || !binding) return world;
  syncFreeRoamSpatialBridge(world, binding);
  return world;
}

export function prepareFreeRoamSpatialInput(world, playerIndex, nextInput, binding) {
  const state = ensureBridgeState(world);
  if (!state || !binding || !world.players?.[playerIndex]) return {...(nextInput || {})};
  const input = {...(nextInput || {})};
  const actionHeld = Boolean(nextInput?.action);
  const rising = actionHeld && !state.gatewayHeld[playerIndex];
  state.gatewayHeld[playerIndex] = actionHeld;
  if (rising && useNearestPassage(world, playerIndex, binding)) input.action = false;
  return input;
}

export function syncFreeRoamSpatialBridge(world, binding) {
  const state = ensureBridgeState(world);
  if (!state || !binding) return world;
  for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
    const player = world.players[playerIndex];
    ensurePlayerSpatialState(player);
    if (player.spatialLocationId === binding.id) {
      const space = bindingSpace(binding, player.spatialSpaceId);
      if (!space) {
        player.spatialLocationId = null;
        player.spatialSpaceId = null;
        player.spatialFloorZ = 0;
      } else {
        player.spatialFloorZ = Number(space.floorZ) || 0;
        clampToCurrentSpace(world, playerIndex, player, binding, state);
      }
    } else if (!player.spatialLocationId) {
      player.spatialFloorZ = 0;
      player.spatialSpaceId = null;
    }
    player.z = player.spatialFloorZ + Math.max(0, Number(player.jumpHeight) || 0);
    announceNearbyEntrance(world, playerIndex, player, binding, state);
  }
  return world;
}

function relativeDirection(player, target) {
  const dx = (Number(target?.x) || 0) - (Number(player?.x) || 0);
  const dy = (Number(target?.y) || 0) - (Number(player?.y) || 0);
  const bearing = Math.atan2(dx, -dy) * 180 / Math.PI;
  const relative = wrapDegrees(bearing - (Number(player?.heading) || 0));
  if (Math.abs(relative) <= 25) return "прямо";
  if (Math.abs(relative) >= 155) return "позади";
  return relative < 0 ? "слева" : "справа";
}

export function freeRoamSpatialStatus(world, playerIndex, binding) {
  const player = world?.players?.[playerIndex];
  if (!player || !binding) return "";
  if (player.spatialLocationId === binding.id) {
    const space = bindingSpace(binding, player.spatialSpaceId);
    return `${binding.label}. ${space?.label || "неизвестное пространство"}. Высота ${Math.round((Number(player.z) || 0) * 10) / 10} метра.`;
  }
  if (player.mode !== "foot") return "";
  const entrance = (binding.passages || []).find(passage => !passage.from?.locationId && passage.to?.locationId === binding.id)?.from;
  if (!entrance) return "";
  const metres = distance2d(player, entrance.position);
  if (metres > 80) return "";
  return `Вход в ${binding.label}: ${Math.max(1, Math.round(metres))} метров ${relativeDirection(player, entrance.position)}.`;
}
