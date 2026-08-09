"use strict";

import {capturedVesselSharedInput} from "./vessel-deck-input-bridge-system.js?v=5";
import {claimedVesselStation, stationOwnsInput, vesselOwnsSubsystem} from "../vessel-authority.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 280) world.events.splice(0, world.events.length - 280);
}

function moduleDefinition(entry, moduleId) {
  return (entry?.definition?.modules || []).find(module => module.id === moduleId) || null;
}

function moduleLabel(registry, entry, moduleId) {
  const definition = moduleDefinition(entry, moduleId);
  const type = definition ? registry?.resolveModuleType?.(definition.type) : null;
  return String(type?.presentation?.label || definition?.label || moduleId || "модуль");
}

function floodDisabled(entry, moduleId) {
  return Boolean(entry?.instance?.interior?.waterBridge?.floodDisabledModules?.[moduleId]);
}

function clearRepairProgress(module) {
  if (!module) return;
  module.repairProgress = 0;
  module.repairQuarter = 0;
  module.repairActive = false;
}

function beginService(entry, module, definition, playerIndex) {
  module.repairWasEnabled = module.enabled !== false;
  module.repairOwner = playerIndex;
  module.repairActive = true;
  module.repairProgress = 0;
  module.repairQuarter = 0;

  if (definition.type === "propulsion") {
    module.enabled = false;
    entry.boat.engineStalled = true;
    entry.boat.throttle = 0;
    entry.boat.restartProgress = 0;
  } else if (definition.type === "pump") {
    module.enabled = false;
    module.active = false;
    entry.boat.pumpActive = false;
  }
}

function restoreInterruptedModule(entry, moduleId, module, definition) {
  const mayRestore = module.repairWasEnabled !== false
    && (Number(module.health) || 0) > 0
    && !floodDisabled(entry, moduleId)
    && !entry.boat?.sunk;
  module.enabled = Boolean(mayRestore);
  if (definition.type === "pump") {
    module.active = false;
    entry.boat.pumpActive = false;
  }
  if (definition.type === "propulsion") {
    entry.boat.throttle = 0;
    entry.boat.restartProgress = 0;
    if (vesselOwnsSubsystem(entry.definition, "flooding")) {
      entry.boat.engineStalled = true;
    } else {
      entry.boat.engineStalled = !mayRestore
        || entry.boat.emergencyActive
        || (Number(entry.boat.fuel) || 0) <= 0.01
        || Number(entry.boat.engineTemp || 0) >= 104;
    }
  }
  delete module.repairWasEnabled;
  delete module.repairOwner;
  clearRepairProgress(module);
}

function interruptService(world, entry, playerIndex, moduleId, module, definition, label, announce = true) {
  const wasActive = Boolean(module?.repairActive);
  if (!wasActive) {
    delete module?.repairOwner;
    clearRepairProgress(module);
    return;
  }
  restoreInterruptedModule(entry, moduleId, module, definition);
  if (announce && Number.isInteger(playerIndex)) {
    emit(world, "vessel-module-repair-cancelled", `Ремонт прерван: ${label}.`, [playerIndex], {
      sourcePlayer: playerIndex,
      boatId: entry.boat.id,
      moduleId,
    });
  }
}

function updateRepairStation({world, registry, entry, playerIndex, station, dt}) {
  const moduleId = String(station.object.controlsModule || "");
  const module = entry.instance?.modules?.[moduleId];
  const definition = moduleDefinition(entry, moduleId);
  if (!module || !definition) return;

  const label = moduleLabel(registry, entry, moduleId);
  const input = capturedVesselSharedInput(world, playerIndex) || {};
  const repairing = Boolean(input.repair && stationOwnsInput(entry, playerIndex, "repair"));
  const invalid = entry.boat?.sunk || world.players?.[playerIndex]?.combat?.alive === false;
  if (!repairing || invalid) {
    module.repairLatched = false;
    delete module.repairDeniedReason;
    interruptService(world, entry, playerIndex, moduleId, module, definition, label, !invalid && repairing === false);
    return;
  }

  // One continuous hold can consume at most one plate. The same latch also
  // prevents an impossible repair from repeating its denial every 1.3 seconds:
  // one physical hold gets one clear result, then the player must release and
  // deliberately try again.
  if (module.repairLatched) return;

  const health = clamp(module.health ?? 100, 0, 100);
  if (health >= 99.999) {
    interruptService(world, entry, playerIndex, moduleId, module, definition, label, false);
    return;
  }

  const repairConfig = station.object.repair || {};
  const duration = Math.max(0.5, Number(repairConfig.durationSeconds) || 4.5);
  const amount = Math.max(1, Number(repairConfig.amount) || 50);
  const resourceField = String(repairConfig.resourceField || "repairPatches");
  const available = Math.max(0, Math.floor(Number(entry.boat?.[resourceField]) || 0));

  if (available <= 0) {
    module.repairDeniedReason = "no-repair-patches";
    module.repairLatched = true;
    emit(world, "vessel-module-repair-denied", `Ремонт невозможен: ${label}. Ремонтные пластины закончились.`, [playerIndex], {
      sourcePlayer: playerIndex,
      boatId: entry.boat.id,
      moduleId,
      reason: module.repairDeniedReason,
    });
    interruptService(world, entry, playerIndex, moduleId, module, definition, label, false);
    return;
  }

  delete module.repairDeniedReason;
  if (!module.repairActive) {
    beginService(entry, module, definition, playerIndex);
    emit(world, "vessel-module-repair-start", `Ремонт: ${label}. Модуль отключён на время обслуживания.`, [playerIndex], {
      sourcePlayer: playerIndex,
      boatId: entry.boat.id,
      moduleId,
    });
  }

  module.repairProgress = Math.max(0, Number(module.repairProgress) || 0) + Math.max(0, Number(dt) || 0);
  const quarter = Math.min(4, Math.floor(module.repairProgress / duration * 4));
  if (quarter > (Number(module.repairQuarter) || 0) && quarter < 4) {
    module.repairQuarter = quarter;
    emit(world, "vessel-module-repair-progress", `${label}: ремонт ${quarter * 25} процентов.`, [playerIndex], {
      sourcePlayer: playerIndex,
      boatId: entry.boat.id,
      moduleId,
      percent: quarter * 25,
    });
  }
  if (module.repairProgress < duration) return;

  entry.boat[resourceField] = Math.max(0, available - 1);
  module.health = clamp(health + amount, 0, 100);
  module.enabled = module.health > 0 && !floodDisabled(entry, moduleId) && !entry.boat.sunk;
  module.active = false;
  module.repairLatched = true;
  delete module.repairWasEnabled;
  delete module.repairOwner;
  delete module.repairDeniedReason;
  clearRepairProgress(module);

  if (definition.type === "propulsion") {
    entry.boat.throttle = 0;
    entry.boat.restartProgress = 0;
    if (vesselOwnsSubsystem(entry.definition, "flooding")) {
      entry.boat.engineStalled = true;
    } else {
      entry.boat.engineStalled = !module.enabled
        || entry.boat.emergencyActive
        || (Number(entry.boat.fuel) || 0) <= 0.01
        || Number(entry.boat.engineTemp || 0) >= 104;
    }
  }
  if (definition.type === "pump") entry.boat.pumpActive = false;

  const finish = definition.type === "propulsion" && module.enabled && vesselOwnsSubsystem(entry.definition, "flooding")
    ? " Запуск двигателя пройдёт штатно после короткой задержки."
    : "";
  emit(world, "vessel-module-repair-complete", `${label} восстановлен до ${Math.round(module.health)} процентов. Пластин осталось ${entry.boat[resourceField]}.${finish}`, [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: entry.boat.id,
    moduleId,
    health: module.health,
    enabled: module.enabled,
    repairPatches: entry.boat[resourceField],
  });
}

function repairStations(entry) {
  const result = [];
  for (const deck of entry?.definition?.decks || []) {
    for (const object of deck.objects || []) {
      if (object?.kind !== "station" || object.stationRole !== "repair" || !object.controlsModule) continue;
      result.push({deck, object, resourceId: String(object.resourceId || object.id || "")});
    }
  }
  return result;
}

function cleanupUnownedRepairs(world, registry, entry, ownedResources) {
  for (const station of repairStations(entry)) {
    if (ownedResources.has(station.resourceId)) continue;
    const moduleId = String(station.object.controlsModule || "");
    const module = entry.instance?.modules?.[moduleId];
    const definition = moduleDefinition(entry, moduleId);
    if (!module || !definition) continue;
    const previousOwner = Number.isInteger(module.repairOwner) ? module.repairOwner : null;
    const label = moduleLabel(registry, entry, moduleId);
    if (module.repairActive) {
      interruptService(world, entry, previousOwner, moduleId, module, definition, label, Number.isInteger(previousOwner));
    }
    module.repairLatched = false;
    delete module.repairOwner;
    delete module.repairDeniedReason;
  }
}

function updateModuleRepairs({world, registry, nativeVessels, dt} = {}) {
  if (!world || !registry) return;
  for (const entry of nativeVessels || []) {
    if (!vesselOwnsSubsystem(entry?.definition, "repair")) continue;
    const ownedResources = new Set();
    for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
      const station = claimedVesselStation(entry, playerIndex);
      if (!station?.object?.controlsModule || station.object.stationRole !== "repair") continue;
      ownedResources.add(station.resourceId);
      updateRepairStation({world, registry, entry, playerIndex, station, dt});
    }
    cleanupUnownedRepairs(world, registry, entry, ownedResources);
  }
}

export const VESSEL_MODULE_REPAIR_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-module-repair-before-step-v5",
    phase: "before-step",
    order: 30,
    run: updateModuleRepairs,
  }),
]);
