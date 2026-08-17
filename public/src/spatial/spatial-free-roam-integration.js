"use strict";

import {compileSpatialLocation, createSpatialModuleRegistry} from "./spatial-compiler.js";
import {createSpatialRuntime} from "./spatial-runtime.js";
import {STANDARD_SPATIAL_MODULE_TYPES} from "./spatial-standard-modules.js";
import {describeNearbySpatialEntry, nearbySpatialSemantics} from "./spatial-accessibility.js";
import {distance3d, localToWorld, resolveSpaceWorldTransform, spaceContainsLocalPoint, worldToLocal} from "./spatial-transform.js";
import {spatialLocationIdFromNavigationTargetId, spatialLocationNavigationTargetId} from "./spatial-location-catalog.js";
import {turnBoatToSonar} from "../free-roam-sonar-guide.js";

const runtimesByWorld = new WeakMap();
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const distance2d = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: Number(world.time) || 0, operationEvent: true, spatialEvent: true, ...extra});
  if (world.events.length > 220) world.events.splice(0, world.events.length - 220);
}

function playerEntityId(index) {
  return `player.free.${index + 1}`;
}

function ensureArchitecture(world) {
  const count = world?.players?.length || 0;
  world.spatialArchitecture ||= {};
  const state = world.spatialArchitecture;
  state.version = Math.max(3, Number(state.version) || 0);
  state.locationStates ||= {};
  state.locationNavigation ||= [];
  state.actionHeld ||= [];
  state.locationSonarHeld ||= [];
  state.locationGuideHeld ||= [];
  state.proximity ||= [];
  while (state.locationNavigation.length < count) state.locationNavigation.push(null);
  while (state.actionHeld.length < count) state.actionHeld.push(false);
  while (state.locationSonarHeld.length < count) state.locationSonarHeld.push(false);
  while (state.locationGuideHeld.length < count) state.locationGuideHeld.push(false);
  while (state.proximity.length < count) state.proximity.push(null);
  for (const player of world?.players || []) {
    if (!("spatialLocationId" in player)) player.spatialLocationId = null;
    if (!("spatialSpaceId" in player)) player.spatialSpaceId = null;
    if (!Number.isFinite(player.spatialFloorZ)) player.spatialFloorZ = 0;
    if (!Number.isFinite(player.z)) player.z = Math.max(0, Number(player.jumpHeight) || 0);
    if (!("spatialBounds" in player)) player.spatialBounds = null;
  }
  return state;
}

function runtimeMap(world) {
  let map = runtimesByWorld.get(world);
  if (!map) {
    map = new Map();
    runtimesByWorld.set(world, map);
  }
  return map;
}

function spaceWorldBounds(runtime, spaceId) {
  const space = runtime.location.spacesById.get(spaceId);
  if (!space) return null;
  const points = space.shape.outer.map(point => localToWorld(runtime.location, spaceId, point, runtime.dynamicTransforms));
  return Object.freeze({
    minX: Math.min(...points.map(point => point.x)),
    maxX: Math.max(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)),
    maxY: Math.max(...points.map(point => point.y)),
    floorZ: resolveSpaceWorldTransform(runtime.location, spaceId, runtime.dynamicTransforms).position.z,
  });
}

function endpointForEntity(runtime, entity, connection) {
  if (connection.from.spaceId === entity.spaceId) return connection.from;
  if (connection.bidirectional && connection.to.spaceId === entity.spaceId) return connection.to;
  return null;
}

function interactionRange(connection) {
  return Math.max(0.8, Number(connection?.interactionRange ?? connection?.traversal?.interactionRange) || 2.8);
}

function discoverRange(connection) {
  return Math.max(interactionRange(connection) + 1, Number(connection?.discoverRadius) || 8);
}

class FreeRoamSpatialLocationIntegration {
  constructor({definition, portal, mode = "production", extraModuleTypes = []} = {}) {
    if (!definition) throw new TypeError("spatial free-roam location needs a definition");
    this.definition = definition;
    this.registry = createSpatialModuleRegistry([...STANDARD_SPATIAL_MODULE_TYPES, ...extraModuleTypes]);
    this.compiled = compileSpatialLocation(definition, {moduleRegistry: this.registry, mode});
    this.portal = Object.freeze({
      id: String(portal?.id || `portal.${definition.id}`),
      position: Object.freeze({
        x: Number(portal?.position?.x) || 0,
        y: Number(portal?.position?.y) || 0,
        z: Number(portal?.position?.z) || 0,
      }),
      radius: Math.max(1, Number(portal?.radius) || 4),
      exitRadius: Math.max(0.8, Number(portal?.exitRadius) || 3),
      discoverRadius: Math.max(2, Number(portal?.discoverRadius) || 18),
      spawnId: String(portal?.spawnId || definition.spawns?.[0]?.id || ""),
      exitAnchorId: portal?.exitAnchorId ? String(portal.exitAnchorId) : null,
      outsideLabel: String(portal?.outsideLabel || "берег"),
    });
  }

  runtime(world) {
    const map = runtimeMap(world);
    let runtime = map.get(this.compiled.id);
    if (runtime) return runtime;
    runtime = createSpatialRuntime(this.compiled, {clock: () => Math.round((Number(world?.time) || 0) * 1000)});
    const saved = ensureArchitecture(world).locationStates[this.compiled.id];
    if (saved) {
      try { runtime.restoreState(saved); }
      catch (error) {
        emit(world, "spatial-restore-recovered", `Состояние локации восстановлено через безопасный резерв: ${error?.message || error}`, [0, 1], {locationId: this.compiled.id});
      }
    }
    map.set(this.compiled.id, runtime);
    return runtime;
  }

  persist(world, runtime) {
    ensureArchitecture(world).locationStates[this.compiled.id] = runtime.saveState();
  }

  ensurePlayerMirror(world, playerIndex, runtime) {
    const player = world?.players?.[playerIndex];
    if (!player) return null;
    const id = playerEntityId(playerIndex);
    const existing = runtime.getEntity(id);
    if (player.spatialLocationId !== this.compiled.id || player.mode === "dead") {
      if (existing) runtime.removeEntity(id);
      return null;
    }
    if (existing) return existing;
    const space = this.compiled.spacesById.get(player.spatialSpaceId);
    if (space) {
      try {
        const floor = resolveSpaceWorldTransform(this.compiled, space.id, runtime.dynamicTransforms).position.z;
        const local = worldToLocal(this.compiled, space.id, {x: player.x, y: player.y, z: floor}, runtime.dynamicTransforms);
        if (spaceContainsLocalPoint(space, local)) {
          return runtime.placeEntity({id, kind: "player", label: `Игрок ${playerIndex + 1}`, spaceId: space.id, position: local, mode: "foot"});
        }
      } catch {}
    }
    return runtime.spawnEntity({id, kind: "player", label: `Игрок ${playerIndex + 1}`, spawnId: this.portal.spawnId});
  }

  enter(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    if (!player || player.mode !== "foot") return false;
    const runtime = this.runtime(world);
    const id = playerEntityId(playerIndex);
    if (runtime.getEntity(id)) runtime.removeEntity(id);
    const entity = runtime.spawnEntity({id, kind: "player", label: `Игрок ${playerIndex + 1}`, spawnId: this.portal.spawnId});
    const position = runtime.getEntityWorldPosition(id);
    const floor = resolveSpaceWorldTransform(this.compiled, entity.spaceId, runtime.dynamicTransforms).position.z;
    player.mode = "foot";
    player.activeBoat = null;
    player.x = position.x;
    player.y = position.y;
    player.spatialLocationId = this.compiled.id;
    player.spatialSpaceId = entity.spaceId;
    player.spatialFloorZ = floor;
    player.z = position.z;
    player.airborne = false;
    player.jumpHeight = 0;
    player.jumpVelocity = 0;
    player.spatialBounds = spaceWorldBounds(runtime, entity.spaceId);
    emit(world, "location-enter", `Ты вошёл в ${this.compiled.presentation.label}. ${this.compiled.spacesById.get(entity.spaceId)?.presentation?.label || entity.spaceId}. Высота ${Math.round(position.z * 10) / 10} метра.`, [playerIndex], {
      sourcePlayer: playerIndex, locationId: this.compiled.id, spaceId: entity.spaceId, x: position.x, y: position.y, z: position.z,
    });
    this.persist(world, runtime);
    return true;
  }

  exit(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    if (!player || player.spatialLocationId !== this.compiled.id) return false;
    const runtime = this.runtime(world);
    runtime.removeEntity(playerEntityId(playerIndex));
    player.mode = "foot";
    player.activeBoat = null;
    player.x = this.portal.position.x;
    player.y = this.portal.position.y;
    player.spatialLocationId = null;
    player.spatialSpaceId = null;
    player.spatialFloorZ = 0;
    player.z = 0;
    player.spatialBounds = null;
    player.airborne = false;
    player.jumpHeight = 0;
    player.jumpVelocity = 0;
    emit(world, "location-exit", `Ты вышел из ${this.compiled.presentation.label} на ${this.portal.outsideLabel}.`, [playerIndex], {
      sourcePlayer: playerIndex, locationId: this.compiled.id, x: player.x, y: player.y, z: 0,
    });
    this.persist(world, runtime);
    return true;
  }

  nearExit(runtime, entity) {
    if (!this.portal.exitAnchorId) return false;
    const found = this.compiled.anchorsById.get(this.portal.exitAnchorId);
    return Boolean(found && found.spaceId === entity.spaceId && distance3d(entity.localPosition, found.anchor.position) <= this.portal.exitRadius);
  }

  nearestConnection(runtime, entity, maximumResolver = interactionRange) {
    let best = null;
    for (const connection of this.compiled.connections) {
      const endpoint = endpointForEntity(runtime, entity, connection);
      if (!endpoint) continue;
      const metres = distance3d(entity.localPosition, endpoint.position);
      if (metres > maximumResolver(connection)) continue;
      if (!best || metres < best.metres) best = {connection, metres};
    }
    return best;
  }

  activateAction(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    if (!player || player.mode !== "foot" || player.airborne) return false;
    if (!player.spatialLocationId) {
      return distance2d(player, this.portal.position) <= this.portal.radius ? this.enter(world, playerIndex) : false;
    }
    if (player.spatialLocationId !== this.compiled.id) return false;
    const runtime = this.runtime(world);
    const entity = this.ensurePlayerMirror(world, playerIndex, runtime);
    if (!entity) return true;
    if (this.nearExit(runtime, entity)) return this.exit(world, playerIndex);
    const selected = this.nearestConnection(runtime, entity);
    if (!selected) {
      const nearby = this.nearestConnection(runtime, entity, discoverRange);
      if (nearby) {
        emit(world, "location-action-too-far", `${nearby.connection.presentation?.label || nearby.connection.label || "Переход"}: ${Math.max(1, Math.round(nearby.metres))} метров. Подойди ближе.`, [playerIndex], {
          sourcePlayer: playerIndex, locationId: this.compiled.id, connectionId: nearby.connection.id, distance: nearby.metres,
        });
      }
      return true;
    }
    const {connection} = selected;
    const state = runtime.getConnectionState(connection.id);
    if (!connection.passableStates.includes(state)) {
      if (["door", "hatch", "lift"].includes(connection.kind) && connection.states.includes("open")) {
        runtime.setConnectionState(connection.id, "open");
        emit(world, "location-connection-open", `${connection.presentation.label} открыта. Нажми действие ещё раз, чтобы пройти.`, [playerIndex], {sourcePlayer: playerIndex, connectionId: connection.id});
      } else {
        emit(world, "location-connection-blocked", `${connection.presentation.label} сейчас недоступна.`, [playerIndex], {sourcePlayer: playerIndex, connectionId: connection.id});
      }
      this.persist(world, runtime);
      return true;
    }
    const beforeSpace = entity.spaceId;
    const moved = runtime.transitionEntity(playerEntityId(playerIndex), connection.id);
    const position = runtime.getEntityWorldPosition(playerEntityId(playerIndex));
    const floor = resolveSpaceWorldTransform(this.compiled, moved.spaceId, runtime.dynamicTransforms).position.z;
    player.mode = "foot";
    player.activeBoat = null;
    player.x = position.x;
    player.y = position.y;
    player.spatialSpaceId = moved.spaceId;
    player.spatialFloorZ = floor;
    player.z = position.z;
    player.spatialBounds = spaceWorldBounds(runtime, moved.spaceId);
    player.airborne = false;
    player.jumpHeight = 0;
    player.jumpVelocity = 0;
    emit(world, "location-passage", `Переход: ${connection.presentation.label}. ${this.compiled.spacesById.get(moved.spaceId)?.presentation?.label || moved.spaceId}. Высота ${Math.round(position.z * 10) / 10} метра.`, [playerIndex], {
      sourcePlayer: playerIndex, locationId: this.compiled.id, connectionId: connection.id, fromSpaceId: beforeSpace, spaceId: moved.spaceId, x: position.x, y: position.y, z: position.z,
    });
    this.persist(world, runtime);
    return true;
  }

  syncInside(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    if (!player || player.spatialLocationId !== this.compiled.id || player.mode === "dead") return;
    const runtime = this.runtime(world);
    const id = playerEntityId(playerIndex);
    const entity = this.ensurePlayerMirror(world, playerIndex, runtime);
    if (!entity) return;
    const space = this.compiled.spacesById.get(entity.spaceId);
    const floor = resolveSpaceWorldTransform(this.compiled, entity.spaceId, runtime.dynamicTransforms).position.z;
    const worldZ = floor + Math.max(0, Number(player.jumpHeight) || 0);
    const local = worldToLocal(this.compiled, entity.spaceId, {x: player.x, y: player.y, z: worldZ}, runtime.dynamicTransforms);
    if (spaceContainsLocalPoint(space, local)) {
      try { runtime.moveEntity(id, local); } catch {}
      player.spatialSpaceId = entity.spaceId;
      player.spatialFloorZ = floor;
      player.z = worldZ;
      player.spatialBounds = spaceWorldBounds(runtime, entity.spaceId);
      return;
    }
    const previous = runtime.getEntityWorldPosition(id);
    player.x = previous.x;
    player.y = previous.y;
    player.spatialSpaceId = entity.spaceId;
    player.spatialFloorZ = floor;
    player.z = floor + Math.max(0, Number(player.jumpHeight) || 0);
    player.spatialBounds = spaceWorldBounds(runtime, entity.spaceId);
    emit(world, "location-boundary", `Граница: ${space?.presentation?.label || space?.label || entity.spaceId}. Дальше прохода нет.`, [playerIndex], {
      sourcePlayer: playerIndex, locationId: this.compiled.id, spaceId: entity.spaceId, x: player.x, y: player.y, z: player.z,
    });
  }

  announceInside(world, playerIndex, proximityState) {
    const player = world?.players?.[playerIndex];
    if (!player || player.spatialLocationId !== this.compiled.id || player.airborne) return null;
    const runtime = this.runtime(world);
    const id = playerEntityId(playerIndex);
    const entity = runtime.getEntity(id);
    if (!entity) return null;
    if (this.portal.exitAnchorId) {
      const found = this.compiled.anchorsById.get(this.portal.exitAnchorId);
      if (found?.spaceId === entity.spaceId) {
        const target = localToWorld(this.compiled, entity.spaceId, found.anchor.position, runtime.dynamicTransforms);
        const metres = distance3d(runtime.getEntityWorldPosition(id), target);
        if (metres <= Math.max(6, this.portal.exitRadius + 2)) {
          const ready = metres <= this.portal.exitRadius;
          const key = `${this.compiled.id}:exit:${ready ? "ready" : "near"}`;
          if (proximityState !== key) {
            emit(world, "location-nearby", ready
              ? `Выход на ${this.portal.outsideLabel} рядом. Нажми действие, чтобы выйти.`
              : `Выход на ${this.portal.outsideLabel}: ${Math.max(1, Math.round(metres))} метров.`, [playerIndex], {
                sourcePlayer: playerIndex, locationId: this.compiled.id, semanticId: this.portal.exitAnchorId, distance: metres, x: target.x, y: target.y, z: target.z,
              });
          }
          return key;
        }
      }
    }
    const entries = nearbySpatialSemantics(runtime, id, {maximumDistance: 10, heading: player.heading});
    const candidate = entries.find(entry => this.compiled.connectionsById.has(entry.id)) || entries[0];
    if (!candidate) return null;
    const connection = this.compiled.connectionsById.get(candidate.id);
    const maximum = connection ? discoverRange(connection) : 5;
    if (candidate.metres > maximum) return null;
    const ready = connection ? candidate.metres <= interactionRange(connection) : candidate.metres <= 2;
    const key = `${this.compiled.id}:${candidate.id}:${ready ? "ready" : "near"}:${candidate.available === false ? "closed" : "open"}`;
    if (proximityState !== key) {
      emit(world, "location-nearby", describeNearbySpatialEntry(candidate, {actionReady: ready && Boolean(connection)}), [playerIndex], {
        sourcePlayer: playerIndex, locationId: this.compiled.id, spaceId: entity.spaceId, semanticId: candidate.id, distance: candidate.metres, x: candidate.position.x, y: candidate.position.y, z: candidate.position.z,
      });
    }
    return key;
  }

  status(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    if (!player) return "";
    if (player.spatialLocationId !== this.compiled.id) {
      if (player.mode !== "foot") return "";
      const metres = distance2d(player, this.portal.position);
      if (metres > 100) return "";
      return `Вход в ${this.compiled.presentation.label}: ${Math.max(1, Math.round(metres))} метров.`;
    }
    const runtime = this.runtime(world);
    const entity = runtime.getEntity(playerEntityId(playerIndex));
    if (!entity) return "";
    const space = this.compiled.spacesById.get(entity.spaceId);
    return `${this.compiled.presentation.label}. ${space?.presentation?.label || space?.label || entity.spaceId}. Высота ${Math.round((Number(player.z) || 0) * 10) / 10} метра.`;
  }
}

export function buildFreeRoamSpatialInterest(world, playerIndex, options = {}) {
  const player = world?.players?.[playerIndex];
  if (!player?.spatialLocationId) return null;
  const runtime = runtimeMap(world).get(player.spatialLocationId);
  if (!runtime) return null;
  const id = playerEntityId(playerIndex);
  if (!runtime.getEntity(id)) return null;
  return runtime.buildInterestSnapshot(id, options);
}

export class FreeRoamSpatialManager {
  constructor({locations = [], mode = "production", extraModuleTypes = []} = {}) {
    this.integrations = Object.freeze((Array.isArray(locations) ? locations : []).map(entry => new FreeRoamSpatialLocationIntegration({
      definition: entry.definition,
      portal: entry.portal,
      mode,
      extraModuleTypes,
    })));
    this.byId = new Map(this.integrations.map(integration => [integration.compiled.id, integration]));
    this.locationCatalog = Object.freeze(this.integrations.map(integration => Object.freeze({
      id: integration.compiled.id,
      label: integration.compiled.presentation.label,
      navigationTargetId: spatialLocationNavigationTargetId(integration.compiled.id),
      position: integration.portal.position,
    })));
  }

  catalog() {
    return this.locationCatalog;
  }

  initialize(world) {
    const state = ensureArchitecture(world);
    world.spatialLocationCatalog = this.locationCatalog;
    for (const integration of this.integrations) integration.runtime(world);
    for (let index = 0; index < (world?.players || []).length; index += 1) {
      const selected = state.locationNavigation[index];
      if (selected && !this.byId.has(selected)) state.locationNavigation[index] = null;
    }
    return world;
  }

  selectedIntegration(world, playerIndex) {
    const selected = ensureArchitecture(world).locationNavigation[playerIndex];
    return selected ? this.byId.get(selected) || null : null;
  }

  nearestIntegration(player) {
    let best = null;
    let metres = Infinity;
    for (const integration of this.integrations) {
      const current = distance2d(player, integration.portal.position);
      if (current < metres) {
        metres = current;
        best = integration;
      }
    }
    return best;
  }

  inputIntegration(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    if (player?.spatialLocationId) return this.byId.get(player.spatialLocationId) || null;
    return this.nearestIntegration(player);
  }

  locationTarget(integration) {
    return integration ? {
      id: spatialLocationNavigationTargetId(integration.compiled.id),
      kind: "location",
      label: integration.compiled.presentation.label,
      x: integration.portal.position.x,
      y: integration.portal.position.y,
      z: integration.portal.position.z,
      locationId: integration.compiled.id,
    } : null;
  }

  setScenarioTarget(world, playerIndex, integration) {
    if (!world?.freeScenario || !integration) return null;
    world.freeScenario.targets ||= Array.from({length: world.players?.length || 0}, () => null);
    while (world.freeScenario.targets.length < (world.players?.length || 0)) world.freeScenario.targets.push(null);
    const target = this.locationTarget(integration);
    world.freeScenario.targets[playerIndex] = target;
    return target;
  }

  combatOwnsNavigation(world) {
    return Boolean(world?.freeContracts?.encounterActive || world?.freeScenario?.phase === "pursuit");
  }

  handleSonar(world, playerIndex, integration) {
    const player = world?.players?.[playerIndex];
    const target = this.setScenarioTarget(world, playerIndex, integration);
    if (!player || !target) return false;
    const scenario = world.freeScenario;
    scenario.sonarCooldown ||= Array.from({length: world.players?.length || 0}, () => 0);
    scenario.beaconUntil ||= Array.from({length: world.players?.length || 0}, () => 0);
    while (scenario.sonarCooldown.length < world.players.length) scenario.sonarCooldown.push(0);
    while (scenario.beaconUntil.length < world.players.length) scenario.beaconUntil.push(0);
    scenario.sonarCooldown[playerIndex] = 1.1;
    scenario.beaconUntil[playerIndex] = Number.MAX_SAFE_INTEGER;
    const metres = distance2d(player, target);
    emit(world, "scenario-sonar", `Сонар: цель — ${target.label}, ${Math.max(1, Math.round(metres))} метров.`, [playerIndex], {
      sourcePlayer: playerIndex, targetId: target.id, targetKind: "location", locationId: integration.compiled.id, x: target.x, y: target.y, z: target.z, distance: metres,
    });
    return true;
  }

  prepareInput(world, playerIndex, nextInput) {
    const state = ensureArchitecture(world);
    const input = {...(nextInput || {})};
    const player = world?.players?.[playerIndex];
    if (!player) return input;

    if (Object.hasOwn(input, "navigationTargetId")) {
      const locationId = spatialLocationIdFromNavigationTargetId(input.navigationTargetId);
      state.locationNavigation[playerIndex] = locationId && this.byId.has(locationId) ? locationId : null;
    }

    const selected = this.selectedIntegration(world, playerIndex);
    const sonarHeld = Boolean(nextInput?.sonar);
    const sonarRising = sonarHeld && !state.locationSonarHeld[playerIndex];
    state.locationSonarHeld[playerIndex] = sonarHeld;
    if (selected && sonarRising && !this.combatOwnsNavigation(world)) {
      this.handleSonar(world, playerIndex, selected);
      input.sonar = false;
    }

    const guideHeld = Boolean(nextInput?.guide);
    const guideRising = guideHeld && !state.locationGuideHeld[playerIndex];
    state.locationGuideHeld[playerIndex] = guideHeld;
    if (selected && guideRising && !this.combatOwnsNavigation(world)) {
      this.setScenarioTarget(world, playerIndex, selected);
      turnBoatToSonar(world, playerIndex, (targetWorld, type, text, targets, extra = {}) => emit(targetWorld, type, text, targets, extra));
      input.guide = false;
    }

    const actionHeld = Boolean(nextInput?.action);
    const actionRising = actionHeld && !state.actionHeld[playerIndex];
    state.actionHeld[playerIndex] = actionHeld;
    if (actionRising) {
      const integration = this.inputIntegration(world, playerIndex);
      if (integration?.activateAction(world, playerIndex)) input.action = false;
    }
    return input;
  }

  prepareLegacyStep(world) {
    const presence = world?.freeActivities?.presence;
    if (!Array.isArray(presence)) return null;
    const previous = [...presence];
    for (let index = 0; index < (world.players || []).length; index += 1) {
      if (world.players[index]?.spatialLocationId && this.byId.has(world.players[index].spatialLocationId) && world.players[index]?.mode !== "dead") presence[index] = false;
    }
    return previous;
  }

  finishLegacyStep(world, previousPresence) {
    const presence = world?.freeActivities?.presence;
    if (!Array.isArray(presence) || !Array.isArray(previousPresence)) return;
    for (let index = 0; index < previousPresence.length; index += 1) presence[index] = previousPresence[index];
  }

  sync(world) {
    const state = ensureArchitecture(world);
    world.spatialLocationCatalog = this.locationCatalog;
    for (let index = 0; index < (world.players || []).length; index += 1) {
      const player = world.players[index];
      if (player.mode === "dead") {
        player.spatialLocationId = null;
        player.spatialSpaceId = null;
        player.spatialFloorZ = 0;
        player.z = 0;
        player.spatialBounds = null;
        continue;
      }
      const active = player.spatialLocationId ? this.byId.get(player.spatialLocationId) : null;
      if (active) {
        active.syncInside(world, index);
        state.proximity[index] = active.announceInside(world, index, state.proximity[index]);
      } else {
        player.spatialLocationId = null;
        player.spatialSpaceId = null;
        player.spatialFloorZ = 0;
        player.z = Math.max(0, Number(player.jumpHeight) || 0);
        player.spatialBounds = null;
        const nearest = this.nearestIntegration(player);
        if (player.mode === "foot" && nearest) {
          const metres = distance2d(player, nearest.portal.position);
          if (metres <= nearest.portal.discoverRadius) {
            const ready = metres <= nearest.portal.radius;
            const key = `${nearest.compiled.id}:portal:${ready ? "ready" : "near"}`;
            if (state.proximity[index] !== key) {
              emit(world, "location-nearby", ready
                ? `Вход в ${nearest.compiled.presentation.label} рядом. Нажми действие, чтобы войти.`
                : `Рядом вход в ${nearest.compiled.presentation.label}: ${Math.max(1, Math.round(metres))} метров.`, [index], {
                  sourcePlayer: index, locationId: nearest.compiled.id, distance: metres, x: nearest.portal.position.x, y: nearest.portal.position.y, z: nearest.portal.position.z,
                });
            }
            state.proximity[index] = key;
          } else state.proximity[index] = null;
        } else state.proximity[index] = null;
      }
      const selected = this.selectedIntegration(world, index);
      if (selected && !this.combatOwnsNavigation(world)) this.setScenarioTarget(world, index, selected);
    }
    return world;
  }

  status(world, playerIndex) {
    const player = world?.players?.[playerIndex];
    if (!player) return "";
    const active = player.spatialLocationId ? this.byId.get(player.spatialLocationId) : null;
    if (active) return active.status(world, playerIndex);
    const selected = this.selectedIntegration(world, playerIndex);
    if (selected) return selected.status(world, playerIndex);
    return this.nearestIntegration(player)?.status(world, playerIndex) || "";
  }
}
