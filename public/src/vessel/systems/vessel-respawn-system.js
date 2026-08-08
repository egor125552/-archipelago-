"use strict";

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 260) world.events.splice(0, world.events.length - 260);
}

function respawnConfig(definition) {
  const config = definition?.lifecycle?.respawn;
  if (!config || config.enabled === false) return null;
  const delaySeconds = Number(config.delaySeconds);
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) throw new TypeError(`vessel ${definition?.id || "unknown"} respawn.delaySeconds must be greater than zero`);
  const position = config.position || {};
  for (const field of ["x", "y", "heading"]) {
    if (!Number.isFinite(Number(position[field]))) throw new TypeError(`vessel ${definition?.id || "unknown"} respawn.position.${field} must be finite`);
  }
  return {...config, delaySeconds, position: {x: Number(position.x), y: Number(position.y), heading: Number(position.heading)}};
}

function lifecycleState(instance) {
  instance.lifecycle ||= {};
  instance.lifecycle.respawn ||= {active: false, remaining: null};
  return instance.lifecycle.respawn;
}

function resetModules(registry, entry) {
  for (const [moduleId, installation] of Object.entries(entry.instance?.installations || {})) {
    const moduleType = registry?.resolveModuleType?.(String(installation?.type || ""));
    if (!moduleType) continue;
    const staticDefinition = (entry.definition?.modules || []).find(module => module.id === moduleId) || null;
    const config = clone(staticDefinition?.config || installation?.config || {});
    const fresh = moduleType.createState
      ? moduleType.createState(config, {vesselType: entry.definition, module: staticDefinition || installation})
      : {};
    entry.instance.modules[moduleId] = clone(fresh || {});
  }
}

function releaseAboardPlayers(world, boat) {
  for (let playerIndex = 0; playerIndex < (world?.players || []).length; playerIndex += 1) {
    const player = world.players[playerIndex];
    if (!player || player.activeBoat !== boat.id) continue;
    player.activeBoat = null;
    player.mode = "swim";
    player.running = false;
    player.vesselDeckInputOwned = false;
    player.x = Number(boat.x) || 0;
    player.y = Number(boat.y) || 0;
    player.heading = Number(boat.heading) || 0;
  }
}

function restoreBoat(world, registry, entry, config) {
  const boat = entry.boat;
  const identity = {
    id: boat.id,
    owner: boat.owner,
    boatType: boat.boatType,
    vesselType: boat.vesselType,
    vesselInstanceId: boat.vesselInstanceId,
    label: boat.label,
  };
  const defaults = clone(entry.definition?.runtimeDefaults || {});
  Object.assign(boat, defaults, identity, {
    x: config.position.x,
    y: config.position.y,
    heading: config.position.heading,
    speed: 0,
    throttle: 0,
    rudder: 0,
    driver: null,
    sunk: false,
    reserved: false,
    water: Number(defaults.water) || 0,
    leak: Number(defaults.leak) || 0,
    engineStalled: defaults.engineStalled === true,
    pumpActive: false,
    emergencyActive: false,
    restartProgress: 0,
    collisionCooldown: 0,
    cargo: [],
    cargoWeight: 0,
    refuelActive: false,
    refuelProgress: 0,
    engineServiceActive: false,
    engineServiceProgress: 0,
  });
  const capacity = Math.max(1, Math.floor(Number(boat.crewCapacity) || 1));
  boat.crew = Array.from({length: capacity}, () => null);
  delete boat.predictionPhysicsProfile;
  if (entry.instance?.occupants) entry.instance.occupants = {};
  if (entry.instance?.interior?.claims) entry.instance.interior.claims = {};
  if (entry.instance?.interior?.traversals) entry.instance.interior.traversals = {};
  resetModules(registry, entry);
  releaseAboardPlayers(world, boat);
}

function updateRespawns({world, registry, nativeVessels, dt} = {}) {
  if (!world || !registry) return;
  const elapsed = Math.max(0, Number(dt) || 0);
  for (const entry of nativeVessels || []) {
    const config = respawnConfig(entry?.definition);
    if (!config) continue;
    const state = lifecycleState(entry.instance);
    const boat = entry.boat;
    if (!boat?.sunk) {
      state.active = false;
      state.remaining = null;
      continue;
    }
    if (!state.active) {
      state.active = true;
      state.remaining = config.delaySeconds;
      releaseAboardPlayers(world, boat);
      emit(world, "vessel-respawn-start", String(config.startText || `${boat.label || "Судно"} затонуло. Восстановление через ${Math.ceil(config.delaySeconds)} секунд.`), [0, 1], {
        boatId: boat.id,
        boatType: boat.boatType,
        seconds: config.delaySeconds,
        x: boat.x,
        y: boat.y,
      });
      continue;
    }
    state.remaining = Math.max(0, Number(state.remaining) - elapsed);
    if (state.remaining > 0) continue;
    restoreBoat(world, registry, entry, config);
    state.active = false;
    state.remaining = null;
    emit(world, "vessel-respawn-complete", String(config.recoveredText || `${entry.boat.label || "Судно"} восстановлено у причала.`), [0, 1], {
      boatId: entry.boat.id,
      boatType: entry.boat.boatType,
      x: entry.boat.x,
      y: entry.boat.y,
    });
  }
}

export const VESSEL_RESPAWN_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-respawn-lifecycle-v1",
    phase: "after-step",
    order: 35,
    run: updateRespawns,
  }),
]);
