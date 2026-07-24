"use strict";

import {
  ensureRecoveryState,
  injuryMixTarget,
  registerCombatDamage,
  updateCombatRecovery,
} from "./free-roam-combat-recovery.js?v=32";
import {COMBAT_TUNING} from "./free-roam-combat-tuning.js?v=32";
import {isCriticalHealth} from "./free-roam-critical-injury.js?v=32";
import {activePursuers, damageEscort} from "./free-roam-pursuer-squad.js?v=33";
import {describeCombatTarget, resolveCombatTarget} from "./free-roam-targeting.js?v=33";
import {activeHostileGunners, damageHostileGunner} from "./free-roam-hostile-gunners.js?v=32";
import {activeEnemyBoats, damageEnemyBoat} from "./free-roam-enemy-boats.js?v=1";
import {activeHostileActors, damageHostileActor} from "./free-roam-hostile-actors.js?v=1";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

const WEAPON_LABELS = Object.freeze({
  fists: "кулаки",
  knife: "нож",
  automatic: "автомат",
});

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function createCombatState() {
  return {
    health: 100,
    alive: true,
    respawnRemaining: 0,
    knockedDown: false,
    knockdownRemaining: 0,
    stun: 0,
    stamina: 100,
    carriedCrate: null,
    weapons: {knife: false, automatic: false},
    equipped: "fists",
    ammo: 0,
    pendingDamage: 0,
    attackCharge: 0,
    attackCooldown: 0,
    injuryMix: 0,
    lastDamageAt: -999,
    recoveryStarted: false,
    lockedTargetId: null,
    lastTargetRequestId: null,
  };
}

export function ensureCombat(world) {
  for (const player of world.players || []) {
    player.combat ||= createCombatState();
    const combat = player.combat;
    if (!Number.isFinite(combat.health)) combat.health = 100;
    if (typeof combat.alive !== "boolean") combat.alive = combat.health > 0;
    if (!Number.isFinite(combat.respawnRemaining)) combat.respawnRemaining = 0;
    if (typeof combat.knockedDown !== "boolean") combat.knockedDown = false;
    if (!Number.isFinite(combat.knockdownRemaining)) combat.knockdownRemaining = 0;
    if (!Number.isFinite(combat.stun)) combat.stun = 0;
    if (!Number.isFinite(combat.stamina)) combat.stamina = 100;
    combat.weapons ||= {knife: false, automatic: false};
    combat.equipped ||= "fists";
    if (!Number.isFinite(combat.ammo)) combat.ammo = 0;
    if (!Number.isFinite(combat.pendingDamage)) combat.pendingDamage = 0;
    if (!Number.isFinite(combat.attackCharge)) combat.attackCharge = 0;
    if (!Number.isFinite(combat.attackCooldown)) combat.attackCooldown = 0;
    if (!Number.isFinite(combat.injuryMix)) combat.injuryMix = 0;
    if (typeof combat.lockedTargetId !== "string") combat.lockedTargetId = null;
    if (typeof combat.lastTargetRequestId !== "string") combat.lastTargetRequestId = null;
    ensureRecoveryState(combat);
  }
}

function bearing(from, to) {
  return Math.atan2((to?.x || 0) - (from?.x || 0), -((to?.y || 0) - (from?.y || 0))) * 180 / Math.PI;
}

function inAttackCone(attacker, target, range, cone) {
  const metres = distance(attacker, target);
  if (metres > range) return false;
  if (metres < 0.25) return true;
  return Math.abs(wrapDeg(bearing(attacker, target) - (Number(attacker.heading) || 0))) <= cone;
}

function activeTargets(world, attackerIndex) {
  const presence = world.freeActivities?.presence || [true, false];
  const targets = [];
  for (let index = 0; index < world.players.length; index += 1) {
    if (index === attackerIndex || !presence[index]) continue;
    const player = world.players[index];
    if (player?.combat?.alive) targets.push({kind: "player", index, point: player});
  }
  const primary = world.freeActivities?.marauder;
  for (const pursuer of activePursuers(world)) {
    targets.push({
      kind: pursuer === primary ? "marauder" : "escort",
      index: -1,
      pursuerId: pursuer.id,
      point: pursuer,
    });
  }
  for (const boat of activeEnemyBoats(world)) {
    targets.push({kind: "enemyBoat", index: -1, enemyBoatId: boat.id, point: boat});
  }
  for (const gunner of activeHostileGunners(world)) {
    targets.push({kind: "gunner", index: -1, gunnerId: gunner.id, point: gunner});
  }
  for (const actor of activeHostileActors(world)) {
    targets.push({kind: actor.elite ? "elite" : "hostileActor", index: -1, actorId: actor.id, point: actor});
  }
  return targets;
}

function nearestTarget(world, attackerIndex, range, cone, includeMarauder = true) {
  const attacker = world.players[attackerIndex];
  let result = null;
  let best = range;
  for (const target of activeTargets(world, attackerIndex)) {
    if (!includeMarauder && !["player", "gunner", "hostileActor", "elite"].includes(target.kind)) continue;
    const metres = distance(attacker, target.point);
    if (metres > best || !inAttackCone(attacker, target.point, range, cone)) continue;
    best = metres;
    result = {...target, distance: metres};
  }
  return result;
}

function pushPlayer(world, targetIndex, attackerIndex, pushDistance, sourcePoint = null) {
  const target = world.players[targetIndex];
  const attacker = world.players[attackerIndex] || sourcePoint;
  if (!target || !attacker || pushDistance <= 0) return;
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const length = Math.hypot(dx, dy) || 1;
  target.x += dx / length * pushDistance;
  target.y += dy / length * pushDistance;
  if (target.mode === "roof" && pushDistance >= 6) {
    const boat = world.boats[target.activeBoat];
    target.mode = "swim";
    target.activeBoat = null;
    target.x = (boat?.x || target.x) + dx / length * 7;
    target.y = (boat?.y || target.y) + Math.max(7, dy / length * 7);
  }
}

function knockDown(world, targetIndex, attackerIndex, pushDistance, duration, weapon, sourcePoint = null) {
  const target = world.players[targetIndex];
  if (!target?.combat?.alive) return;
  target.combat.knockedDown = true;
  target.combat.knockdownRemaining = Math.max(target.combat.knockdownRemaining, duration);
  pushPlayer(world, targetIndex, attackerIndex, pushDistance, sourcePoint);
  const impactTargets = attackerIndex >= 0 ? [targetIndex, attackerIndex] : [targetIndex];
  emit(world, "player-knockdown", "", impactTargets, {
    sourcePlayer: attackerIndex,
    targetPlayer: targetIndex,
    weapon,
    x: target.x,
    y: target.y,
  });
  emit(world, "player-knockdown-notice", "Тебя сбили с ног.", [targetIndex], {
    sourcePlayer: attackerIndex,
    targetPlayer: targetIndex,
    weapon,
    x: target.x,
    y: target.y,
  });
}

function killPlayer(world, targetIndex, attackerIndex, helpers) {
  const target = world.players[targetIndex];
  const combat = target.combat;
  combat.health = 0;
  combat.alive = false;
  combat.respawnRemaining = 8;
  combat.knockedDown = true;
  combat.knockdownRemaining = 8;
  combat.attackCharge = 0;
  combat.pendingDamage = 0;
  helpers?.dropCarriedCrate?.(world, targetIndex, "После смерти груз выпал.");
  if (target.mode === "boat") {
    const boat = world.boats[target.activeBoat];
    if (boat?.driver === targetIndex) {
      boat.driver = null;
      boat.throttle = 0;
      boat.rudder = 0;
    }
  }
  target.mode = "dead";
  target.activeBoat = null;
  emit(world, "player-death", "Ты погиб. Возрождение у причала через восемь секунд.", [targetIndex], {
    sourcePlayer: attackerIndex,
    targetPlayer: targetIndex,
    x: target.x,
    y: target.y,
  });
  if (attackerIndex >= 0) {
    emit(world, "player-defeated", "Игрок повержен.", [attackerIndex], {
      sourcePlayer: attackerIndex,
      targetPlayer: targetIndex,
      x: target.x,
      y: target.y,
    });
  }
}

function damagePlayer(world, targetIndex, amount, attackerIndex, details, helpers) {
  const target = world.players[targetIndex];
  const combat = target?.combat;
  if (!combat?.alive || amount <= 0) return false;
  combat.health = clamp(combat.health - amount, 0, 100);
  registerCombatDamage(combat, world.time);
  const stunFactor = details.heavy ? 1.8 : details.weapon === "fists" ? 1.8 : 0.92;
  combat.stun = clamp(combat.stun + amount * stunFactor, 0, 100);
  combat.injuryMix = injuryMixTarget(combat);
  const impactTargets = attackerIndex >= 0 ? [targetIndex, attackerIndex] : [targetIndex];
  emit(world, details.eventType || "combat-hit", "", impactTargets, {
    sourcePlayer: attackerIndex,
    targetPlayer: targetIndex,
    weapon: details.weapon,
    heavy: Boolean(details.heavy),
    damage: amount,
    health: combat.health,
    x: target.x,
    y: target.y,
  });
  emit(world, "combat-health", `Здоровье ${Math.round(combat.health)}.`, [targetIndex], {
    sourcePlayer: attackerIndex,
    targetPlayer: targetIndex,
    weapon: details.weapon,
    damage: amount,
    health: combat.health,
    x: target.x,
    y: target.y,
  });
  if (combat.health <= 0) {
    killPlayer(world, targetIndex, attackerIndex, helpers);
    return true;
  }
  if (isCriticalHealth(combat.health) && !combat.knockedDown) {
    knockDown(
      world,
      targetIndex,
      attackerIndex,
      details.heavy ? 7.5 : 3.5,
      details.heavy ? COMBAT_TUNING.heavyKnockdownSeconds : COMBAT_TUNING.lightKnockdownSeconds,
      details.weapon,
      details.sourcePoint,
    );
  } else if (details.heavy && !combat.knockedDown) {
    pushPlayer(world, targetIndex, attackerIndex, 4.5, details.sourcePoint);
  }
  return true;
}

export function applyCombatDamage(world, targetIndex, amount, attackerIndex = -1, details = {}, helpers = {}) {
  ensureCombat(world);
  return damagePlayer(world, targetIndex, amount, attackerIndex, {
    weapon: details.weapon || "environment",
    heavy: Boolean(details.heavy),
    eventType: details.eventType || "combat-hit",
    sourcePoint: details.sourcePoint || null,
  }, helpers);
}

function performMelee(world, attackerIndex, heavyRequested, helpers) {
  const attacker = world.players[attackerIndex];
  const combat = attacker.combat;
  const weapon = combat.equipped === "knife" && combat.weapons.knife ? "knife" : "fists";
  let heavy = Boolean(heavyRequested);
  const cost = heavy ? 34 : 12;
  if (combat.stamina < cost) heavy = false;
  const actualCost = heavy ? 34 : 12;
  if (combat.stamina < actualCost) {
    emit(world, "combat-tired", "Не хватает сил для удара.", [attackerIndex]);
    return;
  }
  combat.stamina -= actualCost;
  combat.attackCooldown = heavy
    ? COMBAT_TUNING.heavyCooldown
    : weapon === "knife"
      ? COMBAT_TUNING.knifeCooldown
      : COMBAT_TUNING.lightCooldown;
  const range = weapon === "knife" ? COMBAT_TUNING.knifeRange : COMBAT_TUNING.fistRange;
  const target = nearestTarget(world, attackerIndex, range, COMBAT_TUNING.meleeCone, false);
  const armouredTarget = target
    ? null
    : nearestTarget(world, attackerIndex, range, COMBAT_TUNING.meleeCone, true);
  emit(world, "combat-swing", "", [attackerIndex], {
    sourcePlayer: attackerIndex,
    weapon,
    heavy,
    x: attacker.x,
    y: attacker.y,
  });
  if (!target && armouredTarget && armouredTarget.kind !== "player") {
    emit(world, "armoured-target", "Кулаки и нож не пробьют катер. Используй автомат или таран лодкой.", [attackerIndex], {
      sourcePlayer: attackerIndex,
      weapon,
      x: armouredTarget.point.x,
      y: armouredTarget.point.y,
    });
    return;
  }
  if (!target) {
    emit(world, "combat-miss", "Удар прошёл мимо.", [attackerIndex], {
      sourcePlayer: attackerIndex,
      weapon,
      heavy,
      x: attacker.x,
      y: attacker.y,
    });
    return;
  }
  const damage = weapon === "knife" ? (heavy ? 38 : 24) : (heavy ? 20 : 9);
  if (target.kind === "gunner") {
    damageHostileGunner(world, target.gunnerId, damage, attackerIndex);
    return;
  }
  if (["hostileActor", "elite"].includes(target.kind)) {
    damageHostileActor(world, target.actorId, damage, attackerIndex, {weapon, heavy});
    return;
  }
  damagePlayer(world, target.index, damage, attackerIndex, {
    weapon,
    heavy,
    eventType: heavy ? "combat-heavy-hit" : "combat-hit",
  }, helpers);
}

function destroyMarauder(world, attackerIndex, helpers) {
  const marauder = world.freeActivities.marauder;
  if (marauder.destroyed) return;
  helpers?.releaseStolenCargo?.(world, marauder);
  marauder.hull = 0;
  marauder.destroyed = true;
  marauder.active = false;
  marauder.speed = 0;
  marauder.respawnAt = 0;
  emit(world, "pursuer-destroyed", "Катер-преследователь уничтожен. На воде остался редкий ящик.", [0, 1], {
    sourcePlayer: attackerIndex,
    x: marauder.x,
    y: marauder.y,
  });
  helpers?.spawnRareCrate?.(world, marauder.x, marauder.y, "valuable", "pursuer");
  helpers?.onEnemyBoatDestroyed?.(world, marauder, attackerIndex);
}

function fireAutomatic(world, attackerIndex, helpers) {
  const attacker = world.players[attackerIndex];
  const combat = attacker.combat;
  if (!combat.weapons.automatic || combat.ammo <= 0) {
    combat.equipped = combat.weapons.knife ? "knife" : "fists";
    emit(world, "gun-empty", "Патроны закончились. Выбраны кулаки.", [attackerIndex]);
    return;
  }
  const lockedTarget = resolveCombatTarget(
    world,
    attackerIndex,
    combat.lockedTargetId,
    COMBAT_TUNING.automaticRange,
  );
  if (combat.lockedTargetId && !lockedTarget) {
    combat.lockedTargetId = null;
    combat.attackCooldown = COMBAT_TUNING.automaticShotInterval;
    emit(world, "target-lost", "Цель потеряна или ушла слишком далеко.", [attackerIndex], {
      sourcePlayer: attackerIndex,
    });
    return;
  }
  combat.ammo -= 1;
  combat.attackCooldown = COMBAT_TUNING.automaticShotInterval;
  const closeTarget = lockedTarget || nearestTarget(
    world,
    attackerIndex,
    COMBAT_TUNING.automaticCloseRange,
    COMBAT_TUNING.automaticCloseCone,
    true,
  );
  const target = closeTarget || nearestTarget(
    world,
    attackerIndex,
    COMBAT_TUNING.automaticRange,
    COMBAT_TUNING.automaticCone,
    true,
  );
  emit(world, "gun-shot", "", [0, 1], {
    sourcePlayer: attackerIndex,
    ammo: combat.ammo,
    x: attacker.x,
    y: attacker.y,
    heading: attacker.heading,
  });
  if (!target) {
    emit(world, "gun-miss", "", [attackerIndex], {
      sourcePlayer: attackerIndex,
      x: attacker.x,
      y: attacker.y,
    });
    return;
  }
  attacker.heading = bearing(attacker, target.point);
  if (target.kind === "player") {
    damagePlayer(world, target.index, COMBAT_TUNING.automaticDamage, attackerIndex, {
      weapon: "automatic",
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
    boat.hull = clamp(boat.hull - 5, 0.05, 100);
    boat.leak = clamp((Number(boat.leak) || 0) + 0.18, 0, 16);
    emit(world, "gun-boat-hit", `Попадание по лодке игрока ${target.playerIndex + 1}.`, [attackerIndex], {
      sourcePlayer: attackerIndex,
      targetPlayer: target.playerIndex,
      targetBoat: boat.id,
      x: boat.x,
      y: boat.y,
    });
    emit(world, "gun-boat-damaged", `Автомат попал в твою лодку. Корпус ${Math.round(boat.hull)}.`, [target.playerIndex], {
      sourcePlayer: attackerIndex,
      targetPlayer: target.playerIndex,
      targetBoat: boat.id,
      hull: boat.hull,
      x: boat.x,
      y: boat.y,
    });
    return;
  }
  if (target.kind === "gunner") {
    damageHostileGunner(world, target.gunnerId, 12, attackerIndex);
    if (target.point?.destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }
  if (["hostileActor", "elite"].includes(target.kind)) {
    damageHostileActor(world, target.actorId, 12, attackerIndex, {weapon: "automatic"});
    if (target.point?.destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }
  if (target.kind === "enemyBoat") {
    damageEnemyBoat(world, target.enemyBoatId, 12, attackerIndex, helpers, {weapon: "automatic"});
    if (target.point?.destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }
  if (target.kind === "escort") {
    damageEscort(world, target.pursuerId, 12, attackerIndex, helpers);
    if (target.point?.destroyed) {
      combat.lockedTargetId = null;
      emit(world, "target-cleared", "", [attackerIndex], {sourcePlayer: attackerIndex});
    }
    return;
  }
  const marauder = target.point;
  marauder.hull = clamp(marauder.hull - 12, 0, 72);
  emit(world, "pursuer-hit", `Попадание. Корпус преследователя ${Math.round(marauder.hull)}.`, [attackerIndex], {
    sourcePlayer: attackerIndex,
    damage: 12,
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

function cycleWeapon(world, playerIndex) {
  const combat = world.players[playerIndex].combat;
  const available = ["fists"];
  if (combat.weapons.knife) available.push("knife");
  if (combat.weapons.automatic && combat.ammo > 0) available.push("automatic");
  const current = Math.max(0, available.indexOf(combat.equipped));
  combat.equipped = available[(current + 1) % available.length];
  emit(world, "weapon-switch", `Выбрано оружие: ${WEAPON_LABELS[combat.equipped]}.`, [playerIndex], {
    sourcePlayer: playerIndex,
    weapon: combat.equipped,
  });
}

function respawnPlayer(world, playerIndex) {
  const player = world.players[playerIndex];
  const combat = player.combat;
  combat.health = 100;
  combat.alive = true;
  combat.respawnRemaining = 0;
  combat.knockedDown = false;
  combat.knockdownRemaining = 0;
  combat.stun = 0;
  combat.stamina = 100;
  combat.injuryMix = 0;
  combat.pendingDamage = 0;
  combat.lastDamageAt = -999;
  combat.recoveryStarted = false;
  player.mode = "foot";
  player.activeBoat = null;
  player.x = 210 + (playerIndex ? 8 : -8);
  player.y = 58;
  player.heading = 180;
  emit(world, "player-respawn", "Ты снова у причала.", [playerIndex], {
    sourcePlayer: playerIndex,
    x: player.x,
    y: player.y,
  });
}

export function updateCombat(world, dt, helpers = {}) {
  ensureCombat(world);
  const state = world.freeActivities;
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const combat = player.combat;
    const input = state.inputs[index] || {};
    const previous = state.previousInputs[index] || {};
    combat.attackCooldown = Math.max(0, combat.attackCooldown - dt);

    if (!state.presence[index]) {
      combat.attackCharge = 0;
      continue;
    }

    if (combat.pendingDamage > 0 && combat.alive) {
      const damage = combat.pendingDamage;
      combat.pendingDamage = 0;
      damagePlayer(world, index, damage, -1, {
        weapon: "environment",
        heavy: false,
        eventType: "combat-hit",
      }, helpers);
    }

    if (!combat.alive) {
      combat.respawnRemaining = Math.max(0, combat.respawnRemaining - dt);
      if (combat.respawnRemaining <= 0) respawnPlayer(world, index);
      continue;
    }

    combat.stamina = clamp(combat.stamina + dt * (combat.knockedDown ? 5 : 18), 0, 100);
    combat.stun = clamp(combat.stun - dt * COMBAT_TUNING.stunDecayPerSecond, 0, 100);
    if (combat.knockedDown) {
      combat.knockdownRemaining = Math.max(0, combat.knockdownRemaining - dt);
      if (combat.knockdownRemaining <= 0) {
        combat.knockedDown = false;
        emit(world, "player-rise", "Ты поднялся.", [index], {sourcePlayer: index, x: player.x, y: player.y});
      }
    }

    const recovery = updateCombatRecovery(combat, world.time, dt);
    if (recovery === "started") {
      emit(world, "health-recovery-start", "Сердцебиение ослабевает. Здоровье восстанавливается.", [index], {
        sourcePlayer: index,
        x: player.x,
        y: player.y,
      });
    } else if (recovery === "complete") {
      emit(world, "health-recovery-complete", "Здоровье полностью восстановлено.", [index], {
        sourcePlayer: index,
        x: player.x,
        y: player.y,
      });
    }
    combat.injuryMix = injuryMixTarget(combat);

    if (input.targetId !== combat.lastTargetRequestId) {
      combat.lastTargetRequestId = input.targetId;
      const requestedTarget = resolveCombatTarget(
        world,
        index,
        input.targetId,
        COMBAT_TUNING.automaticRange,
      );
      combat.lockedTargetId = requestedTarget?.id || null;
      if (requestedTarget) {
        combat.equipped = combat.weapons.automatic && combat.ammo > 0 ? "automatic" : combat.equipped;
        player.heading = bearing(player, requestedTarget.point);
        emit(
          world,
          "target-locked",
          `${describeCombatTarget(requestedTarget)} Захват подтверждён. Удерживай X, когда захочешь стрелять.`,
          [index],
          {
            sourcePlayer: index,
            targetId: requestedTarget.id,
            targetKind: requestedTarget.kind,
            x: requestedTarget.point.x,
            y: requestedTarget.point.y,
          },
        );
      } else if (input.targetId) {
        emit(world, "target-lost", "Эта цель уже недоступна. Открой список клавишей M и выбери другую.", [index], {
          sourcePlayer: index,
          targetId: input.targetId,
        });
      }
    }
    const trackedTarget = resolveCombatTarget(
      world,
      index,
      combat.lockedTargetId,
      COMBAT_TUNING.automaticRange,
    );
    if (combat.lockedTargetId && !trackedTarget) {
      combat.lockedTargetId = null;
      emit(world, "target-lost", "Цель потеряна или ушла слишком далеко.", [index], {
        sourcePlayer: index,
      });
    } else if (trackedTarget) {
      player.heading = bearing(player, trackedTarget.point);
    }

    if (input.weapon && !previous.weapon) cycleWeapon(world, index);
    if (combat.knockedDown) {
      combat.attackCharge = 0;
      continue;
    }

    if (combat.equipped === "automatic") {
      combat.attackCharge = 0;
      if (input.attack && combat.attackCooldown <= 0) fireAutomatic(world, index, helpers);
      continue;
    }

    if (input.attack) combat.attackCharge = Math.min(1.2, combat.attackCharge + dt);
    if (!input.attack && previous.attack && combat.attackCooldown <= 0) {
      const held = combat.attackCharge;
      combat.attackCharge = 0;
      performMelee(world, index, held >= COMBAT_TUNING.heavyChargeSeconds, helpers);
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
  ];
  if (combat.equipped === "automatic" || combat.weapons.automatic) parts.push(`Патронов ${combat.ammo}.`);
  if (combat.knockedDown) parts.push("Ты лежишь после удара.");
  return parts.join(" ");
}
