"use strict";

import {listCombatTargets, resolveCombatTarget} from "./free-roam-targeting.js?v=39";
import {
  DUAL_TURRET_AUTO_TARGET_RANGE,
  DUAL_TURRET_SHOT_INTERVAL,
  DUAL_TURRET_WEAPON_ID,
} from "./free-roam-dual-turret-config.js?v=5";
import {dualTurretBoat} from "./free-roam-dual-turret-boat.js?v=4";
import {fireDualTurretHitscan} from "./free-roam-dual-turret-projectiles.js?v=5";

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 240) world.events.splice(0, world.events.length - 240);
}

function controllerState(world) {
  world.freeDualTurretBoat ||= {};
  const state = world.freeDualTurretBoat;
  for (const turret of state.turrets || []) {
    delete turret.minimumRelativeHeading;
    delete turret.maximumRelativeHeading;
  }
  return state;
}

function mountedTurret(world, playerIndex) {
  const state = world?.freeDualTurretBoat;
  const boat = dualTurretBoat(world);
  const player = world?.players?.[playerIndex];
  if (!state || !boat || player?.mode !== "boat" || player.activeBoat !== boat.id) return null;
  const seat = boat.crew?.indexOf(playerIndex) ?? -1;
  return seat >= 0 ? state.turrets?.[seat] || null : null;
}

function inputObjects(world, playerIndex) {
  return [...new Set([
    world?.freeActivities?.inputs?.[playerIndex],
    world?.operationInputs?.[playerIndex],
    world?.inputs?.[playerIndex],
  ].filter(Boolean))];
}

function setInputField(world, playerIndex, key, value, saved) {
  for (const input of inputObjects(world, playerIndex)) {
    saved.push([input, key, input[key]]);
    input[key] = value;
  }
}

function currentInput(world, playerIndex) {
  return {
    ...(world?.freeActivities?.inputs?.[playerIndex] || {}),
    ...(world?.operationInputs?.[playerIndex] || {}),
    ...(world?.inputs?.[playerIndex] || {}),
  };
}

function fallbackWeapon(combat) {
  if (combat?.lastPersonalWeapon && combat.lastPersonalWeapon !== DUAL_TURRET_WEAPON_ID) {
    return combat.lastPersonalWeapon;
  }
  if (combat?.weapons?.automatic && combat.ammo > 0) return "automatic";
  if (combat?.weapons?.pistol && combat.pistolAmmo > 0) return "pistol";
  if (combat?.weapons?.knife) return "knife";
  return "fists";
}

function keepPersonalWeaponSelected(combat) {
  if (!combat || combat.equipped !== DUAL_TURRET_WEAPON_ID) return;
  combat.equipped = fallbackWeapon(combat);
}

function targetBearing(from, target) {
  return Math.atan2((Number(target?.x) || 0) - (Number(from?.x) || 0), -((Number(target?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;
}

function targetAllowedForBoat(world, boat, target) {
  if (!target) return false;
  if (target.kind === "boat" && target.boatId === boat.id) return false;
  if (target.kind === "player" && world.players?.[target.playerIndex]?.activeBoat === boat.id) return false;
  return true;
}

function automaticHostileTarget(world, playerIndex, boat) {
  return listCombatTargets(world, playerIndex, DUAL_TURRET_AUTO_TARGET_RANGE)
    .find(target => targetAllowedForBoat(world, boat, target)
      && !["player", "boat"].includes(target.kind)) || null;
}

export function selectDualTurretTarget(world, playerIndex, boat) {
  const combat = world.players?.[playerIndex]?.combat;
  const locked = resolveCombatTarget(
    world,
    playerIndex,
    combat?.lockedTargetId,
    DUAL_TURRET_AUTO_TARGET_RANGE,
  );
  if (locked && targetAllowedForBoat(world, boat, locked)) return locked;
  if (combat?.lockedTargetId) combat.lockedTargetId = null;
  const automatic = automaticHostileTarget(world, playerIndex, boat);
  if (automatic && combat) combat.lockedTargetId = automatic.id;
  return automatic;
}

function announceAutomaticTarget(world, playerIndex, combat, target) {
  if (!target || !combat || combat.lastTurretAutoTargetId === target.id) return;
  combat.lastTurretAutoTargetId = target.id;
  emit(world, "target-auto-locked", `Бортовая установка автоматически выбрала цель: ${target.label}.`, [playerIndex], {
    sourcePlayer: playerIndex,
    targetId: target.id,
    targetKind: target.kind,
    x: target.point.x,
    y: target.point.y,
  });
}

function refreshTargetAfterShot(world, playerIndex, boat, previousTarget) {
  if (!previousTarget) return;
  const combat = world.players?.[playerIndex]?.combat;
  const remaining = resolveCombatTarget(
    world,
    playerIndex,
    previousTarget.id,
    DUAL_TURRET_AUTO_TARGET_RANGE,
  );
  if (remaining && targetAllowedForBoat(world, boat, remaining)) return;
  if (combat?.lockedTargetId === previousTarget.id) combat.lockedTargetId = null;
  const replacement = automaticHostileTarget(world, playerIndex, boat);
  if (replacement && combat) {
    combat.lockedTargetId = replacement.id;
    announceAutomaticTarget(world, playerIndex, combat, replacement);
  } else if (combat) {
    combat.lastTurretAutoTargetId = null;
    emit(world, "target-cleared", "Живых боевых целей для бортовой установки не осталось.", [playerIndex], {
      sourcePlayer: playerIndex,
    });
  }
}

function deny(world, playerIndex, turret, text) {
  const now = Number(world.time) || 0;
  if (now - (Number(turret.lastDeniedAt) || -999) < 1.2) return;
  turret.lastDeniedAt = now;
  emit(world, "dual-turret-denied", text, [playerIndex], {
    sourcePlayer: playerIndex,
    turretId: turret.id,
  });
}

function tryFire(world, playerIndex, turret, boat) {
  if (!turret || turret.cooldown > 0) return false;
  if (turret.ammo <= 0) {
    deny(world, playerIndex, turret, "В бортовой установке закончились патроны.");
    return false;
  }
  const combat = world.players?.[playerIndex]?.combat;
  const lockedBefore = combat?.lockedTargetId || null;
  const target = selectDualTurretTarget(world, playerIndex, boat);
  if (target && target.id !== lockedBefore) announceAutomaticTarget(world, playerIndex, combat, target);
  const heading = target
    ? targetBearing(boat, target.point)
    : (Number.isFinite(Number(turret.heading)) ? Number(turret.heading) : Number(boat.heading) || 0);
  turret.heading = heading;
  turret.cooldown = DUAL_TURRET_SHOT_INTERVAL;
  turret.ammo -= 1;
  const shot = fireDualTurretHitscan(world, {
    boat,
    turret,
    sourcePlayer: playerIndex,
    heading,
    target,
  });
  emit(world, "dual-turret-shot", "", [0, 1], {
    sourcePlayer: playerIndex,
    boatId: boat.id,
    turretId: turret.id,
    projectileId: shot.id,
    weapon: DUAL_TURRET_WEAPON_ID,
    ammo: turret.ammo,
    heading,
    instant: true,
    x: shot.x,
    y: shot.y,
    impactX: shot.impactX,
    impactY: shot.impactY,
    targetId: target?.id ?? null,
  });
  refreshTargetAfterShot(world, playerIndex, boat, target);
  return true;
}

export function prepareDualTurretWeaponStep(world) {
  const state = controllerState(world);
  const saved = [];
  const players = [];
  for (let playerIndex = 0; playerIndex < world.players.length; playerIndex += 1) {
    const input = currentInput(world, playerIndex);
    const combat = world.players[playerIndex]?.combat;
    const turret = mountedTurret(world, playerIndex);
    const mounted = Boolean(turret);
    keepPersonalWeaponSelected(combat);

    // While seated in the armored patrol, attack always belongs to the mounted
    // installation. No weapon selection, target lock, aiming sector or turn
    // delay is required. With no target the shot simply travels into empty space.
    const firing = Boolean(mounted && input.attack);
    if (firing) setInputField(world, playerIndex, "attack", false, saved);
    players.push({playerIndex, turret, mounted, firing});
  }
  return {state, saved, players};
}

function restoreSaved(saved) {
  for (let index = saved.length - 1; index >= 0; index -= 1) {
    const [input, key, value] = saved[index];
    input[key] = value;
  }
}

export function finishDualTurretWeaponStep(world, context, dt) {
  const boat = dualTurretBoat(world);
  restoreSaved(context.saved);
  for (const turret of boat?.turrets || []) turret.cooldown = Math.max(0, Number(turret.cooldown) - dt);
  for (const entry of context.players) {
    const combat = world.players?.[entry.playerIndex]?.combat;
    keepPersonalWeaponSelected(combat);
    if (entry.firing && combat?.alive && entry.turret?.assignedPlayer === entry.playerIndex) {
      tryFire(world, entry.playerIndex, entry.turret, boat);
    }
  }
}
