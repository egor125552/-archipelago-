"use strict";

import {applyCombatAiModelV165} from "./free-roam-combat-ai-model-v165.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const bearing = (from, to) => Math.atan2(
  (Number(to?.x) || 0) - (Number(from?.x) || 0),
  -((Number(to?.y) || 0) - (Number(from?.y) || 0)),
) * 180 / Math.PI;

const CUSTOM_PHASES = new Set([
  "breach-escaping-v166",
  "breach-stopping-v166",
  "breach-repairing-v166",
  "breach-returning-v166",
]);

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function actorForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player) return null;
  if (["boat", "roof"].includes(player.mode)) return world.boats?.[player.activeBoat] || player;
  return player;
}

function livingActors(world) {
  return (world.players || [])
    .map((player, index) => ({player, actor: actorForPlayer(world, index)}))
    .filter(({player, actor}, index) => world.freeActivities?.presence?.[index] !== false && player?.combat?.alive && actor)
    .map(item => item.actor);
}

function ensureState(world) {
  world.freeCombatAiV166 ||= {frame: null};
  return world.freeCombatAiV166;
}

function safePoint(world, boat) {
  const candidates = [
    {x: 28, y: 286},
    {x: 392, y: 286},
    {x: 32, y: 112},
    {x: 388, y: 112},
  ];
  const living = livingActors(world);
  return candidates.sort((left, right) => {
    const leftScore = living.length ? Math.min(...living.map(actor => distance(left, actor))) : distance(left, boat);
    const rightScore = living.length ? Math.min(...living.map(actor => distance(right, actor))) : distance(right, boat);
    return rightScore - leftScore;
  })[0];
}

function snapshotBoat(boat) {
  if (!boat) return null;
  return {
    x: boat.x,
    y: boat.y,
    heading: boat.heading,
    speed: boat.speed,
    fireCooldown: boat.fireCooldown,
    burstRemaining: boat.burstRemaining,
    aimRemaining: boat.aimRemaining,
  };
}

function suppressHeavyFire(boat) {
  if (!boat) return;
  boat.burstRemaining = 0;
  boat.aimRemaining = 0;
  boat.fireCooldown = Math.max(999, Number(boat.fireCooldown) || 0);
  boat.turretDisabled = true;
}

function prepareOverlay(world) {
  const state = ensureState(world);
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  state.frame = {
    eventStart: world.events?.length || 0,
    phase: heavy?.phase || null,
    armourBreached: Boolean(heavy?.armourBreached),
    position: snapshotBoat(boat),
    engineHealth: Number(boat?.engineHealth) || 0,
    turretHealth: Number(boat?.turretHealth) || 0,
  };
  if (boat && heavy && CUSTOM_PHASES.has(heavy.phase)) suppressHeavyFire(boat);
  return state;
}

function restorePositionForCustomPhase(state, heavy, boat) {
  if (!state.frame?.position || !CUSTOM_PHASES.has(state.frame.phase) || !CUSTOM_PHASES.has(heavy.phase)) return;
  Object.assign(boat, state.frame.position);
}

function moveHeavy(boat, destination, desiredSpeed, dt) {
  const desired = bearing(boat, destination);
  boat.heading = wrapDeg((Number(boat.heading) || 0) + clamp(wrapDeg(desired - (Number(boat.heading) || 0)), -38 * dt, 38 * dt));
  boat.speed += clamp(desiredSpeed - (Number(boat.speed) || 0), -7 * dt, 5.4 * dt);
  const angle = boat.heading * Math.PI / 180;
  boat.x = clamp((Number(boat.x) || 0) + Math.sin(angle) * boat.speed * dt, 14, 406);
  boat.y = clamp((Number(boat.y) || 0) - Math.cos(angle) * boat.speed * dt, 84, 306);
  return distance(boat, destination);
}

function customSystemDestroyed(boat) {
  if ((Number(boat?.engineHealth) || 0) <= 0) return "engine";
  if ((Number(boat?.turretHealth) || 0) <= 0) return "turret";
  return null;
}

function announceNoPlates(world, boat, heavy, system) {
  if (heavy.v166NoPlateSystem === system) return;
  heavy.v166NoPlateSystem = system;
  emit(world, "heavy-repair-no-plates", `Система тяжёлого катера уничтожена, но ремонтных пластин больше нет.`, [0, 1], {
    system,
    plates: 0,
    x: boat.x,
    y: boat.y,
  });
}

function startSystemRecovery(world, boat, heavy, system) {
  if (!system || CUSTOM_PHASES.has(heavy.phase)) return false;
  if ((Number(heavy.repairPlates) || 0) <= 0) {
    announceNoPlates(world, boat, heavy, system);
    return false;
  }
  heavy.v166NoPlateSystem = null;
  heavy.repairSystem = system;
  heavy.repairProgress = 0;
  heavy.repairQuarter = 0;
  heavy.destination = safePoint(world, boat);
  heavy.phase = system === "engine" ? "breach-stopping-v166" : "breach-escaping-v166";
  suppressHeavyFire(boat);
  emit(world, "heavy-system-recovery-v166", system === "engine"
    ? "Двигатель тяжёлого катера уничтожен. Катер теряет ход, физически останавливается и готовит аварийный ремонт."
    : "Орудийная установка тяжёлого катера уничтожена. Катер даёт полный газ, уходит из-под огня и готовит ремонт.", [0, 1], {
    system,
    plates: heavy.repairPlates,
    x: boat.x,
    y: boat.y,
  });
  return true;
}

function startArmourBreachEscape(world, boat, heavy) {
  heavy.repairProgress = 0;
  heavy.repairQuarter = 0;
  heavy.destination = safePoint(world, boat);
  const destroyedSystem = customSystemDestroyed(boat);
  heavy.repairSystem = destroyedSystem;
  if (destroyedSystem && (Number(heavy.repairPlates) || 0) <= 0) {
    announceNoPlates(world, boat, heavy, destroyedSystem);
    heavy.repairSystem = null;
  }
  heavy.phase = destroyedSystem === "engine" ? "breach-stopping-v166" : "breach-escaping-v166";
  suppressHeavyFire(boat);
  emit(world, "heavy-breach-escape-v166", destroyedSystem === "engine"
    ? "Броня тяжёлого катера уничтожена. Двигатель тоже разбит: катер теряет ход и начинает аварийную остановку."
    : "Броня тяжёлого катера уничтожена. Он немедленно даёт полный газ и физически уходит из-под огня.", [0, 1], {
    system: destroyedSystem,
    plates: heavy.repairPlates,
    x: boat.x,
    y: boat.y,
  });
}

function beginRepairAtRest(world, boat, heavy) {
  if (!heavy.repairSystem) {
    heavy.phase = "breach-returning-v166";
    heavy.destination = heavy.combatPoint || {x: boat.x, y: boat.y};
    emit(world, "heavy-breach-turn-v166", "Тяжёлый катер завершил рывок, разворачивается и возвращается в бой с открытым корпусом.", [0, 1], {x: boat.x, y: boat.y});
    return;
  }
  if ((Number(heavy.repairPlates) || 0) <= 0) {
    announceNoPlates(world, boat, heavy, heavy.repairSystem);
    heavy.repairSystem = null;
    heavy.phase = "breach-returning-v166";
    heavy.destination = heavy.combatPoint || {x: boat.x, y: boat.y};
    return;
  }
  boat.speed = 0;
  heavy.phase = "breach-repairing-v166";
  heavy.repairProgress = 0;
  heavy.repairQuarter = 0;
  heavy.lastDamageAt = Math.min(Number(heavy.lastDamageAt) || -999, (Number(world.time) || 0) - 1.3);
  emit(world, "heavy-repair-start-v166", `Тяжёлый катер остановился. Экипаж начал ремонт ${heavy.repairSystem === "engine" ? "двигателя" : "орудийной установки"} пластинами.`, [0, 1], {
    system: heavy.repairSystem,
    plates: heavy.repairPlates,
    x: boat.x,
    y: boat.y,
  });
}

function updateStopping(world, boat, heavy, dt) {
  suppressHeavyFire(boat);
  boat.speed += clamp(0 - (Number(boat.speed) || 0), -5.8 * dt, 5.8 * dt);
  const angle = (Number(boat.heading) || 0) * Math.PI / 180;
  boat.x = clamp((Number(boat.x) || 0) + Math.sin(angle) * boat.speed * dt, 14, 406);
  boat.y = clamp((Number(boat.y) || 0) - Math.cos(angle) * boat.speed * dt, 84, 306);
  if (Math.abs(Number(boat.speed) || 0) > 0.3) return;
  boat.speed = 0;
  beginRepairAtRest(world, boat, heavy);
}

function updateEscape(world, boat, heavy, dt) {
  suppressHeavyFire(boat);
  if ((Number(boat.engineHealth) || 0) <= 0) {
    heavy.repairSystem = "engine";
    heavy.phase = "breach-stopping-v166";
    return updateStopping(world, boat, heavy, dt);
  }
  const destination = heavy.destination || safePoint(world, boat);
  heavy.destination = destination;
  const remaining = moveHeavy(boat, destination, 13.4, dt);
  if (remaining > 5) return;
  boat.x = destination.x;
  boat.y = destination.y;
  boat.speed = 0;
  beginRepairAtRest(world, boat, heavy);
}

function updateRepair(world, boat, heavy, dt) {
  suppressHeavyFire(boat);
  boat.speed = 0;
  const system = heavy.repairSystem;
  if (!system) return beginRepairAtRest(world, boat, heavy);
  const quiet = (Number(world.time) || 0) - (Number(heavy.lastDamageAt) || -999) >= 1.2;
  if (quiet) heavy.repairProgress = (Number(heavy.repairProgress) || 0) + dt;
  else heavy.repairProgress = Math.max(0, (Number(heavy.repairProgress) || 0) - dt * 1.5);
  const duration = system === "engine" ? 9 : 12;
  const quarter = Math.min(4, Math.floor(heavy.repairProgress / duration * 4));
  if (quarter > (Number(heavy.repairQuarter) || 0) && quarter < 4) {
    heavy.repairQuarter = quarter;
    emit(world, "heavy-repair-progress-v166", `Ремонт тяжёлого катера: ${quarter * 25} процентов.`, [0, 1], {
      system,
      percent: quarter * 25,
      x: boat.x,
      y: boat.y,
    });
  }
  if (heavy.repairProgress < duration) return;

  if (system === "engine") {
    boat.engineHealth = Math.max(1, (Number(boat.maxEngineHealth) || 180) * 0.68);
    boat.engineDisabled = false;
    heavy.actualEngineDisabled = false;
  } else {
    boat.turretHealth = Math.max(1, (Number(boat.maxTurretHealth) || 240) * 0.68);
    boat.turretDisabled = false;
    heavy.actualTurretDisabled = false;
  }
  heavy.repairPlates = Math.max(0, (Number(heavy.repairPlates) || 0) - 1);
  heavy.v166NoPlateSystem = null;
  heavy.repairSystem = null;
  heavy.repairProgress = 0;
  heavy.repairQuarter = 0;
  emit(world, "heavy-repair-complete-v166", `Ремонт ${system === "engine" ? "двигателя" : "орудийной установки"} завершён. Осталось пластин: ${heavy.repairPlates}.`, [0, 1], {
    system,
    plates: heavy.repairPlates,
    x: boat.x,
    y: boat.y,
  });

  const nextSystem = customSystemDestroyed(boat);
  if (nextSystem && (Number(heavy.repairPlates) || 0) > 0) {
    heavy.repairSystem = nextSystem;
    heavy.destination = safePoint(world, boat);
    heavy.phase = nextSystem === "engine" ? "breach-stopping-v166" : "breach-escaping-v166";
    emit(world, "heavy-system-recovery-v166", `Экипаж переключился на ремонт ${nextSystem === "engine" ? "двигателя" : "орудийной установки"}.`, [0, 1], {
      system: nextSystem,
      plates: heavy.repairPlates,
      x: boat.x,
      y: boat.y,
    });
    return;
  }
  if (nextSystem) announceNoPlates(world, boat, heavy, nextSystem);
  heavy.phase = "breach-returning-v166";
  heavy.destination = heavy.combatPoint || {x: boat.x, y: boat.y};
}

function updateReturn(world, boat, heavy, dt) {
  suppressHeavyFire(boat);
  if ((Number(boat.engineHealth) || 0) <= 0) {
    heavy.repairSystem = "engine";
    heavy.phase = "breach-stopping-v166";
    return updateStopping(world, boat, heavy, dt);
  }
  const destination = heavy.destination || heavy.combatPoint || {x: boat.x, y: boat.y};
  const remaining = moveHeavy(boat, destination, 12.1, dt);
  if (remaining > 8) return;
  heavy.phase = "combat";
  heavy.destination = null;
  boat.speed = 0;
  heavy.actualEngineDisabled = (Number(boat.engineHealth) || 0) <= 0;
  heavy.actualTurretDisabled = (Number(boat.turretHealth) || 0) <= 0;
  boat.engineDisabled = heavy.actualEngineDisabled;
  boat.turretDisabled = heavy.actualTurretDisabled;
  boat.fireCooldown = heavy.actualTurretDisabled ? 999 : 1.5;
  emit(world, "heavy-breach-returned-v166", "Тяжёлый катер вернулся в бой. Внутренний корпус остаётся открытым.", [0, 1], {x: boat.x, y: boat.y});
}

function finishOverlay(world, dt) {
  const state = ensureState(world);
  const frame = state.frame;
  const heavy = world.freeCombatAiV164?.heavy;
  const boat = world.freeHeavyPursuer?.boat;
  if (!frame || !heavy || !boat || !boat.active || boat.destroyed) {
    state.frame = null;
    return state;
  }

  const newEvents = (world.events || []).slice(frame.eventStart || 0);
  const armourBreachedNow = !frame.armourBreached && heavy.armourBreached
    || newEvents.some(event => event?.type === "heavy-armour-breached");

  restorePositionForCustomPhase(state, heavy, boat);
  heavy.actualEngineDisabled = (Number(boat.engineHealth) || 0) <= 0;
  heavy.actualTurretDisabled = (Number(boat.turretHealth) || 0) <= 0;

  if (armourBreachedNow && !CUSTOM_PHASES.has(heavy.phase)) {
    startArmourBreachEscape(world, boat, heavy);
  } else if (heavy.phase === "combat") {
    // V164 normally starts the pre-breach repair. This fallback also covers
    // missed component-destruction events and keeps the same recovery system
    // available after the armour has already been torn away.
    startSystemRecovery(world, boat, heavy, customSystemDestroyed(boat));
  } else if (CUSTOM_PHASES.has(heavy.phase) && !heavy.repairSystem) {
    const destroyedSystem = customSystemDestroyed(boat);
    if (destroyedSystem && (Number(heavy.repairPlates) || 0) > 0) {
      heavy.repairSystem = destroyedSystem;
      heavy.repairProgress = 0;
      heavy.repairQuarter = 0;
      if (destroyedSystem === "engine") heavy.phase = "breach-stopping-v166";
      else if (heavy.phase === "breach-returning-v166") {
        heavy.phase = "breach-escaping-v166";
        heavy.destination = safePoint(world, boat);
      }
      emit(world, "heavy-system-recovery-v166", destroyedSystem === "engine"
        ? "Двигатель тяжёлого катера уничтожен во время манёвра. Катер теряет ход и готовит аварийный ремонт."
        : "Орудийная установка уничтожена во время манёвра. Катер продолжает отход и готовит ремонт.", [0, 1], {
        system: destroyedSystem,
        plates: heavy.repairPlates,
        x: boat.x,
        y: boat.y,
      });
    } else if (destroyedSystem) {
      announceNoPlates(world, boat, heavy, destroyedSystem);
    }
  }

  if (heavy.phase === "breach-escaping-v166") updateEscape(world, boat, heavy, dt);
  else if (heavy.phase === "breach-stopping-v166") updateStopping(world, boat, heavy, dt);
  else if (heavy.phase === "breach-repairing-v166") updateRepair(world, boat, heavy, dt);
  else if (heavy.phase === "breach-returning-v166") updateReturn(world, boat, heavy, dt);

  state.frame = null;
  return state;
}

export function prepareCombatAiV166Overlay(world) {
  return prepareOverlay(world);
}

export function finishCombatAiV166Overlay(world, dt) {
  return finishOverlay(world, Math.max(0, Number(dt) || 0));
}

export function applyCombatAiModelV166(world, dt, helpers = {}) {
  if ((Number(dt) || 0) <= 0) {
    applyCombatAiModelV165(world, 0, helpers);
    return prepareOverlay(world);
  }
  applyCombatAiModelV165(world, dt, helpers);
  return finishOverlay(world, dt);
}
