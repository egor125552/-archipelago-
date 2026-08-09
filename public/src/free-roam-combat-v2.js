"use strict";

import * as base from "./free-roam-combat.js?v=35";
import {COMBAT_TUNING} from "./free-roam-combat-tuning.js?v=33";
import {damageHostileGunner} from "./free-roam-hostile-gunners.js?v=32";
import {damageEscort} from "./free-roam-pursuer-squad.js?v=33";
import {damageEnemyBoat} from "./free-roam-enemy-boats.js?v=3";
import {damageHostileActor} from "./free-roam-hostile-actors.js?v=3";
import {damageHeavyPursuer} from "./free-roam-heavy-pursuer.js?v=4";
import {damageEliteBoatBoss} from "./free-roam-elite-boat.js?v=2";
import {describeCombatTarget, listCombatTargets, resolveCombatTarget} from "./free-roam-targeting.js?v=39";

export const PISTOL_START_AMMO = 36;
export const COMBAT_TARGET_LOCK_RANGE = 320;

const WEAPON_LABELS = Object.freeze({
  fists: "кулаки",
  knife: "нож",
  pistol: "пистолет",
  automatic: "автомат",
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function bearing(from, to) {
  return Math.atan2((to?.x || 0) - (from?.x || 0), -((to?.y || 0) - (from?.y || 0))) * 180 / Math.PI;
}

function inAttackCone(attacker, target, range, cone) {
  const metres = distance(attacker, target);
  if (metres > range) return false;
  if (metres < 0.25) return true;
  return Math.abs(wrapDeg(bearing(attacker, target) - (Number(attacker.heading) || 0))) <= cone;
}

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function removeRecentTargetEvents(world, eventStart, playerIndex) {
  for (let index = world.events.length - 1; index >= eventStart; index -= 1) {
    const event = world.events[index];
    if (!event || !["target-lost", "target-cleared"].includes(event.type)) continue;
    const sourcePlayer = Number(event.sourcePlayer ?? event.targets?.[0]);
    if (sourcePlayer === playerIndex) world.events.splice(index, 1);
  }
}

function announceOutOfWeaponRange(world, playerIndex, target, weapon) {
  const combat = world.players?.[playerIndex]?.combat;
  if (!combat || !target) return;
  const now = Number(world.time) || 0;
  if (now - (Number(combat.lastTargetRangeNoticeAt) || -999) < 1.5) return;
  combat.lastTargetRangeNoticeAt = now;
  const weaponLabel = weapon === "pistol" ? "пистолета" : "автомата";
  emit(
    world,
    "target-out-of-weapon-range",
    `Цель остаётся захваченной, но находится слишком далеко для ${weaponLabel}. Сократи дистанцию или используй мега-бомбу.`,
    [playerIndex],
    {
      sourcePlayer: playerIndex,
      targetId: target.id,
      targetKind: target.kind,
      weapon,
      distance: Math.round(target.distance),
      x: target.point.x,
      y: target.point.y,
    },
  );
}

function ensurePistol(combat) {
  if (!combat) return;
  combat.weapons ||= {knife: false, automatic: false};
  combat.weapons.pistol = true;
  if (!Number.isFinite(combat.pistolAmmo)) combat.pistolAmmo = PISTOL_START_AMMO;
  if (!Number.isFinite(combat.pistolCooldown)) combat.pistolCooldown = 0;
  if (!Number.isFinite(combat.lastTargetRangeNoticeAt)) combat.lastTargetRangeNoticeAt = -999;
}

export function ensureCombat(world) {
  base.ensureCombat(world);
  for (const player of world?.players || []) ensurePistol(player?.combat);
}

export const applyCombatDamage = base.applyCombatDamage;

function availableWeapons(combat) {
  const available = ["fists"];
  if (combat.weapons?.knife) available.push("knife");
  if (combat.weapons?.pistol && combat.pistolAmmo > 0) available.push("pistol");
  if (combat.weapons?.automatic && combat.ammo > 0) available.push("automatic");
  return available;
}

function fallbackWeapon(combat) {
  if (combat.weapons?.pistol && combat.pistolAmmo > 0) return "pistol";
  if (combat.weapons?.knife) return "knife";
  return "fists";
}

function cycleWeapon(world, playerIndex) {
  const combat = world.players[playerIndex].combat;
  const available = availableWeapons(combat);
  const current = available.indexOf(combat.equipped);
  combat.equipped = available[current >= 0 ? (current + 1) % available.length : 0];
  emit(world, "weapon-switch", `Выбрано оружие: ${WEAPON_LABELS[combat.equipped]}.`, [playerIndex], {
    sourcePlayer: playerIndex,
    weapon: combat.equipped,
  });
}

function combatEncounterActive(world) {
  return Boolean(world?.freeContracts?.encounterActive || world?.freeScenario?.phase === "pursuit");
}

function nextEnemyTarget(world, attackerIndex) {
  return listCombatTargets(world, attackerIndex, COMBAT_TARGET_LOCK_RANGE)
    .filter(target => !["player", "boat"].includes(target.kind))[0] || null;
}

function nearestPistolTarget(world, attackerIndex) {
  const attacker = world.players[attackerIndex];
  const targets = listCombatTargets(world, attackerIndex, COMBAT_TUNING.pistolRange);
  const close = targets.find(target => inAttackCone(
    attacker,
    target.point,
    COMBAT_TUNING.pistolCloseRange,
    COMBAT_TUNING.pistolCloseCone,
  ));
  if (close) return close;
  return targets.find(target => inAttackCone(
    attacker,
    target.point,
    COMBAT_TUNING.pistolRange,
    COMBAT_TUNING.pistolCone,
  )) || null;
}

function destroyMarauder(world, attackerIndex, helpers) {
  const marauder = world.freeActivities?.marauder;
  if (!marauder || marauder.destroyed) return;
  helpers?.releaseStolenCargo?.(world, marauder);
  marauder.hull = 0;
  marauder.destroyed = true;
  marauder.active = false;
  marauder.speed = 0;
  marauder.respawnAt = 0;
  emit(world, "pursuer-destroyed", "Катер-преследователь уничтожен. На воде остался редкий ящик.", [0, 1], {
    sourcePlayer: attackerIndex,
    weapon: "pistol",
    x: marauder.x,
    y: marauder.y,
  });
  helpers?.spawnRareCrate?.(world, marauder.x, marauder.y, "valuable", "pursuer");
  helpers?.onEnemyBoatDestroyed?.(world, marauder, attackerIndex);
}

function maskExtendedBoatHulls(world, eventStart) {
  const records = [];
  for (const boat of world?.boats || []) {
    if (!boat) continue;
    const hullMax = Math.max(1, Number(boat.hullMax) || 100);
    const hull = Math.max(0, Number(boat.hull) || 0);
    if (hullMax <= 100 || hull <= 100) continue;
    records.push({boat, hullMax, hull, maskedHull: 100});
    boat.hull = 100;
  }
  return () => {
    for (const record of records) {
      const maskedAfter = clamp(Number(record.boat.hull) || 0, 0, record.maskedHull);
      const damage = Math.max(0, record.maskedHull - maskedAfter);
      record.boat.hull = Math.max(0, record.hull - damage);
      for (const event of (world?.events || []).slice(eventStart)) {
        if (event?.targetBoat !== record.boat.id || !["gun-boat-hit", "gun-boat-damaged"].includes(event.type)) continue;
        event.hull = record.boat.hull;
        event.hullMax = record.hullMax;
        if (event.type === "gun-boat-damaged") {
          event.text = `Твоя лодка под огнём. Корпус ${Math.round(record.boat.hull)} из ${Math.round(record.hullMax)}.`;
        } else {
          const targetPlayer = Number(event.targetPlayer);
          const playerText = Number.isInteger(targetPlayer) ? ` игрока ${targetPlayer + 1}` : "";
          event.text = `Попадание по лодке${playerText}. Корпус ${Math.round(record.boat.hull)} из ${Math.round(record.hullMax)}.`;
        }
      }
    }
  };
}

function firePistol(world, attackerIndex, helpers) {
  const attacker = world.players[attackerIndex];
  const combat = attacker.combat;
  if (!combat.weapons?.pistol || combat.pistolAmmo <= 0) {
    combat.equipped = fallbackWeapon(combat);
    emit(world, "gun-empty", `Патроны пистолета закончились. Выбрано оружие: ${WEAPON_LABELS[combat.equipped]}.`, [attackerIndex]);
    return;
  }

  const retainedTarget = resolveCombatTarget(
    world,
    attackerIndex,
    combat.lockedTargetId,
    COMBAT_TARGET_LOCK_RANGE,
  );
  const lockedTarget = resolveCombatTarget(
    world,
    attackerIndex,
    combat.lockedTargetId,
    COMBAT_TUNING.pistolRange,
  );
  if (combat.lockedTargetId && !retainedTarget) {
    combat.lockedTargetId = null;
    combat.pistolCooldown = COMBAT_TUNING.pistolShotInterval;
    emit(world, "target-lost", "Цель уничтожена или ушла за пределы дальнего захвата.", [attackerIndex], {
      sourcePlayer: attackerIndex,
    });
    return;
  }
  if (retainedTarget && !lockedTarget) {
    combat.pistolCooldown = COMBAT_TUNING.pistolShotInterval;
    announceOutOfWeaponRange(world, attackerIndex, retainedTarget, "pistol");
    return;
  }

  combat.pistolAmmo -= 1;
  combat.pistolCooldown = COMBAT_TUNING.pistolShotInterval;
  const target = lockedTarget || nearestPistolTarget(world, attackerIndex);
  emit(world, "gun-shot", "", [0, 1], {
    sourcePlayer: attackerIndex,
    weapon: "pistol",
    pistolAmmo: combat.pistolAmmo,
    x: attacker.x,
    y: attacker.y,
    heading: attacker.heading,
  });

  if (!target) {
    emit(world, "gun-miss", "", [attackerIndex], {
      sourcePlayer: attackerIndex,
      weapon: "pistol",
      x: attacker.x,
      y: attacker.y,
    });
    return;
  }

  attacker.heading = bearing(attacker, target.point);
  if (target.kind === "player") {
    base.applyCombatDamage(world, target.playerIndex, COMBAT_TUNING.pistolDamage, attackerIndex, {
      weapon: "pistol",
      heavy: false,
      eventType: "gun-hit",
    }, helpers);
    if (!target.point?.combat?.alive) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }

  if (target.kind === "boat") {
    const boat = target.point;
    const hullMax = Math.max(1, Number(boat.hullMax) || 100);
    boat.hull = clamp(boat.hull - COMBAT_TUNING.pistolBoatDamage, 0.05, hullMax);
    boat.leak = clamp((Number(boat.leak) || 0) + COMBAT_TUNING.pistolBoatLeak, 0, 16);
    emit(world, "gun-boat-hit", `Попадание из пистолета по лодке игрока ${target.playerIndex + 1}. Корпус ${Math.round(boat.hull)} из ${Math.round(hullMax)}.`, [attackerIndex], {
      sourcePlayer: attackerIndex,
      targetPlayer: target.playerIndex,
      targetBoat: boat.id,
      weapon: "pistol",
      hull: boat.hull,
      hullMax,
      x: boat.x,
      y: boat.y,
    });
    emit(world, "gun-boat-damaged", `Пистолет попал в твою лодку. Корпус ${Math.round(boat.hull)} из ${Math.round(hullMax)}.`, [target.playerIndex], {
      sourcePlayer: attackerIndex,
      targetPlayer: target.playerIndex,
      targetBoat: boat.id,
      weapon: "pistol",
      hull: boat.hull,
      hullMax,
      x: boat.x,
      y: boat.y,
    });
    return;
  }

  if (target.kind === "gunner") {
    damageHostileGunner(world, target.gunnerId, COMBAT_TUNING.pistolDamage, attackerIndex);
    if (target.point?.destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }

  if (["hostileActor", "elite"].includes(target.kind)) {
    damageHostileActor(world, target.actorId, COMBAT_TUNING.pistolDamage, attackerIndex, {weapon: "pistol"});
    if (target.point?.destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }

  if (["eliteArmor", "eliteHull", "eliteTurret", "eliteBombBay"].includes(target.kind)) {
    damageEliteBoatBoss(world, target.component || "hull", COMBAT_TUNING.pistolDamage, attackerIndex, {weapon: "pistol"});
    const boss = world.freeEliteBoatBoss;
    const destroyed = target.kind === "eliteTurret"
      ? boss?.boat?.turrets?.find(item => item.id === target.turretId)?.destroyed
      : target.kind === "eliteBombBay"
        ? boss?.bombBay?.destroyed
        : boss?.boat?.destroyed;
    if (destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }
  if (["heavyHull", "heavyTurret", "heavyEngine"].includes(target.kind)) {
    damageHeavyPursuer(world, target.component || "hull", COMBAT_TUNING.pistolDamage, attackerIndex, helpers, {weapon: "pistol"});
    return;
  }
  if (target.kind === "enemyBoat") {
    damageEnemyBoat(world, target.enemyBoatId, COMBAT_TUNING.pistolBoatDamage, attackerIndex, helpers, {weapon: "pistol"});
    if (target.point?.destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }

  if (target.kind === "escort") {
    damageEscort(world, target.pursuerId, COMBAT_TUNING.pistolDamage, attackerIndex, helpers);
    if (target.point?.destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }

  const marauder = target.point;
  marauder.hull = clamp(marauder.hull - COMBAT_TUNING.pistolDamage, 0, 72);
  emit(world, "pursuer-hit", `Попадание из пистолета. Корпус преследователя ${Math.round(marauder.hull)}.`, [attackerIndex], {
    sourcePlayer: attackerIndex,
    weapon: "pistol",
    damage: COMBAT_TUNING.pistolDamage,
    hull: marauder.hull,
    x: marauder.x,
    y: marauder.y,
  });
  if (marauder.hull <= 0) {
    destroyMarauder(world, attackerIndex, helpers);
    combat.lockedTargetId = null;
    emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
  }
}

export function updateCombat(world, dt, helpers = {}) {
  ensureCombat(world);
  const state = world.freeActivities;
  const intercepted = [];
  const eventStart = world.events?.length || 0;

  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const combat = player.combat;
    const input = state.inputs[index] || {};
    const previous = state.previousInputs[index] || {};
    combat.pistolCooldown = Math.max(0, combat.pistolCooldown - dt);

    if (input.weapon && !previous.weapon) cycleWeapon(world, index);

    if (combat.equipped === "automatic" && combat.ammo <= 0 && input.attack && combat.pistolAmmo > 0) {
      combat.equipped = "pistol";
      emit(world, "gun-empty", "Патроны автомата закончились. Выбран пистолет.", [index], {
        sourcePlayer: index,
      });
    }

    const explicitTargetChange = input.targetId !== previous.targetId;
    const requestedTarget = explicitTargetChange
      ? resolveCombatTarget(world, index, input.targetId, COMBAT_TARGET_LOCK_RANGE)
      : null;
    const retainedBefore = combat.lockedTargetId
      ? resolveCombatTarget(world, index, combat.lockedTargetId, COMBAT_TARGET_LOCK_RANGE)
      : null;
    const suspendedLongLock = Boolean(
      !explicitTargetChange
      && retainedBefore
      && retainedBefore.distance > COMBAT_TUNING.automaticRange
    );
    const pistolAttack = combat.equipped === "pistol" && Boolean(input.attack);
    intercepted.push({
      input,
      previous,
      attack: input.attack,
      previousAttack: previous.attack,
      weapon: input.weapon,
      pistolAttack,
      equippedBefore: combat.equipped,
      lockedBefore: combat.lockedTargetId,
      retainedBefore,
      targetRequestBefore: input.targetId,
      explicitTargetChange,
      requestedTarget,
      suspendedLongLock,
    });
    input.weapon = false;
    if (explicitTargetChange) input.targetId = combat.lastTargetRequestId;
    if (suspendedLongLock) {
      combat.lockedTargetId = null;
      if (combat.equipped === "automatic") input.attack = false;
    }
    if (combat.equipped === "pistol") {
      input.attack = false;
      previous.attack = false;
    }
  }

  const restoreExtendedBoatHulls = maskExtendedBoatHulls(world, eventStart);
  try {
    base.updateCombat(world, dt, helpers);
  } finally {
    restoreExtendedBoatHulls();
  }

  for (let index = 0; index < intercepted.length; index += 1) {
    const saved = intercepted[index];
    saved.input.attack = saved.attack;
    saved.previous.attack = saved.previousAttack;
    saved.input.weapon = saved.weapon;
    saved.input.targetId = saved.targetRequestBefore;
    const player = world.players[index];
    const combat = player.combat;

    if (saved.explicitTargetChange) {
      combat.lastTargetRequestId = saved.targetRequestBefore;
      removeRecentTargetEvents(world, eventStart, index);
      const requested = saved.requestedTarget
        ? resolveCombatTarget(world, index, saved.requestedTarget.id, COMBAT_TARGET_LOCK_RANGE)
        : null;
      combat.lockedTargetId = requested?.id || null;
      if (requested) {
        if (combat.weapons.automatic && combat.ammo > 0) combat.equipped = "automatic";
        player.heading = bearing(player, requested.point);
        emit(
          world,
          "target-locked",
          `${describeCombatTarget(requested)} Захват подтверждён. Дальность оружия проверяется только в момент выстрела.`,
          [index],
          {
            sourcePlayer: index,
            targetId: requested.id,
            targetKind: requested.kind,
            distance: Math.round(requested.distance),
            x: requested.point.x,
            y: requested.point.y,
          },
        );
      } else if (saved.targetRequestBefore) {
        emit(world, "target-lost", "Эта цель уже уничтожена или дальше 320 метров.", [index], {
          sourcePlayer: index,
          targetId: saved.targetRequestBefore,
        });
      }
    }

    if (saved.suspendedLongLock && !saved.explicitTargetChange) {
      const sameTarget = resolveCombatTarget(world, index, saved.lockedBefore, COMBAT_TARGET_LOCK_RANGE);
      if (sameTarget) {
        combat.lockedTargetId = sameTarget.id;
        player.heading = bearing(player, sameTarget.point);
      }
    }

    if (saved.equippedBefore === "pistol" && combat.pistolAmmo > 0 && combat.equipped === "automatic" && !saved.explicitTargetChange) {
      combat.equipped = "pistol";
    }
    if (!state.presence[index] || !combat.alive || combat.knockedDown) continue;

    if (saved.suspendedLongLock && saved.attack && saved.equippedBefore === "automatic" && combat.lockedTargetId) {
      const sameTarget = resolveCombatTarget(world, index, combat.lockedTargetId, COMBAT_TARGET_LOCK_RANGE);
      if (sameTarget) announceOutOfWeaponRange(world, index, sameTarget, "automatic");
    }

    if (saved.pistolAttack && combat.equipped === "pistol" && combat.pistolCooldown <= 0) {
      firePistol(world, index, helpers);
    }

    if (saved.explicitTargetChange) continue;
    if (saved.lockedBefore && !combat.lockedTargetId) {
      const sameTarget = resolveCombatTarget(world, index, saved.lockedBefore, COMBAT_TARGET_LOCK_RANGE);
      removeRecentTargetEvents(world, eventStart, index);
      if (sameTarget) {
        combat.lockedTargetId = sameTarget.id;
        player.heading = bearing(player, sameTarget.point);
        continue;
      }
      if (!combatEncounterActive(world)) {
        emit(world, "target-lost", "Цель уничтожена или ушла дальше 320 метров.", [index], {sourcePlayer: index});
        continue;
      }
      const replacement = nextEnemyTarget(world, index);
      if (replacement) {
        combat.lockedTargetId = replacement.id;
        emit(world, "target-auto-locked", `Предыдущая цель недоступна. Новая боевая цель: ${replacement.label}.`, [index], {
          sourcePlayer: index,
          targetId: replacement.id,
          targetKind: replacement.kind,
          x: replacement.point.x,
          y: replacement.point.y,
        });
      } else {
        emit(world, "target-cleared", "Живых боевых целей не осталось.", [index], {sourcePlayer: index});
      }
    }
  }
}

export function combatStatus(world, playerIndex) {
  ensureCombat(world);
  const combat = world.players[playerIndex]?.combat;
  if (!combat) return "";
  if (!combat.alive) return `Ты погиб. Возрождение через ${Math.ceil(combat.respawnRemaining)} секунд.`;
  const parts = [
    `Здоровье ${Math.round(combat.health)}.`,
    `Оружие: ${WEAPON_LABELS[combat.equipped] || combat.equipped}.`,
    `Патронов пистолета ${Math.max(0, Math.floor(combat.pistolAmmo))}.`,
  ];
  if (combat.weapons.automatic) parts.push(`Патронов автомата ${Math.max(0, Math.floor(combat.ammo))}.`);
  if (combat.knockedDown) parts.push("Ты лежишь после удара.");
  return parts.join(" ");
}
