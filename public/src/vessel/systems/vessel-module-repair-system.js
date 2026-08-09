"use strict";

import {capturedVesselSharedInput} from "./vessel-deck-input-bridge-system.js?v=2";
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

function resetProgress(state) {
  if (!state) return;
  state.repairProgress = 0;
  state.repairQuarter = 0;
  state.repairActive = false;
}

function updateRepairStation({world, registry, entry, playerIndex, station, dt}) {
  const moduleId = String(station.object.controlsModule || "");
  const module = entry.instance?.modules?.[moduleId];
  const definition = moduleDefinition(entry, moduleId);
  if (!module || !definition) return;

  const input = capturedVesselSharedInput(world, playerIndex) || {};
  const repairing = Boolean(input.repair && stationOwnsInput(entry, playerIndex, "repair"));
  if (!repairing || entry.boat?.sunk || world.players?.[playerIndex]?.combat?.alive === false) {
    resetProgress(module);
    return;
  }

  const health = clamp(module.health ?? 100, 0, 100);
  if (health >= 99.999) {
    resetProgress(module);
    return;
  }

  const repairConfig = station.object.repair || {};
  const duration = Math.max(0.5, Number(repairConfig.durationSeconds) || 4.5);
  const amount = Math.max(1, Number(repairConfig.amount) || 50);
  const resourceField = String(repairConfig.resourceField || "repairPatches");
  const available = Math.max(0, Math.floor(Number(entry.boat?.[resourceField]) || 0));
  const label = moduleLabel(registry, entry, moduleId);

  if (available <= 0) {
    const now = Number(world.time) || 0;
    if (now - (Number(module.lastRepairDeniedAt) || -999) >= 1.3) {
      module.lastRepairDeniedAt = now;
      emit(world, "vessel-module-repair-denied", `Нечем ремонтировать ${label}: ремонтные пластины закончились.`, [playerIndex], {
        sourcePlayer: playerIndex,
        boatId: entry.boat.id,
        moduleId,
      });
    }
    resetProgress(module);
    return;
  }

  if (!module.repairActive) {
    module.repairActive = true;
    module.repairProgress = 0;
    module.repairQuarter = 0;
    emit(world, "vessel-module-repair-start", `Ремонт: ${label}.`, [playerIndex], {
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
  module.enabled = module.health > 0 && !floodDisabled(entry, moduleId);
  resetProgress(module);

  if (definition.type === "propulsion") {
    if (module.enabled && !entry.boat.emergencyActive && (Number(entry.boat.fuel) || 0) > 0.01 && Number(entry.boat.engineTemp || 0) < 104) {
      entry.boat.engineStalled = false;
    } else entry.boat.engineStalled = true;
  }
  if (definition.type === "pump" && !module.enabled) entry.boat.pumpActive = false;

  emit(world, "vessel-module-repair-complete", `${label} восстановлен до ${Math.round(module.health)} процентов. Пластин осталось ${entry.boat[resourceField]}.`, [playerIndex], {
    sourcePlayer: playerIndex,
    boatId: entry.boat.id,
    moduleId,
    health: module.health,
    enabled: module.enabled,
    repairPatches: entry.boat[resourceField],
  });
}

function updateModuleRepairs({world, registry, nativeVessels, dt} = {}) {
  if (!world || !registry) return;
  for (const entry of nativeVessels || []) {
    if (!vesselOwnsSubsystem(entry?.definition, "repair")) continue;
    for (let playerIndex = 0; playerIndex < (world.players || []).length; playerIndex += 1) {
      const station = claimedVesselStation(entry, playerIndex);
      if (!station?.object?.controlsModule || station.object.stationRole !== "repair") continue;
      updateRepairStation({world, registry, entry, playerIndex, station, dt});
    }
  }
}

export const VESSEL_MODULE_REPAIR_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "vessel-module-repair-before-step-v1",
    phase: "before-step",
    order: 30,
    run: updateModuleRepairs,
  }),
]);
