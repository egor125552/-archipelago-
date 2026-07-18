"use strict";

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
  const marauder = world.freeActivities?.marauder;
  if (marauder?.active && !marauder.destroyed) targets.push({kind: "marauder", index: -1, point: marauder});
  return targets;
}

function nearestTarget(world, attackerIndex, range, cone, includeMarauder = true) {
  const attacker = world.players[attackerIndex];
  let result = null;
  let best = range;
  for (const target of activeTargets(world, attackerIndex)) {
    if (!includeMarauder && target.kind === "marauder") continue;
    const metres = distance(attacker, target.point);
    if (metres > best || !inAttackCone(attacker, target.point, range, cone)) continue;
    best = metres;
    result = {...target, distance: metres};
  }
  return result;
}

function knockDown(world, targetIndex, attackerIndex, force, weapon) {
  const target = world.players[targetIndex];
  const attacker = world.players[attackerIndex];
  if (!target?.combat?.alive) return;
  target.combat.knockedDown = true;
  target.combat.knockdownRemaining = Math.max(target.combat.knockdownRemaining, force >= 6 ? 2.1 : 1.35);
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const length = Math.hypot(dx, dy) || 1;
  target.x += dx / length * force;
  target.y += dy / length * force;
  if (target.mode === "roof" && force >= 6) {
    const boat = world.boats[target.activeBoat];
    target.mode = "swim";
    target.activeBoat = null;
    target.x = (boat?.x || target.x) + dx / length * 7;
    target.y = (boat?.y || target.y) + Math.max(7, dy / length * 7);
  }
  emit(world, "player-knockdown", "Тебя сбили с ног.", [targetIndex, attackerIndex], {
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
  const targets = attackerIndex >= 0 ? [targetIndex, attackerIndex] : [targetIndex];
  emit(world, "player-death", "Ты погиб. Возрождение у причала через восемь секунд.", targets, {
    sourcePlayer: attackerIndex,
    targetPlayer: targetIndex,
    x: target.x,
    y: target.y,
  });
}

function damagePlayer(world, targetIndex, amount, attackerIndex, details, helpers) {
  const target = world.players[targetIndex];
  const combat = target?.combat;
  if (!combat?.alive || amount <= 0) return false;
  combat.health = clamp(combat.health - amount, 0, 100);
  combat.stun = clamp(combat.stun + amount * (details.heavy ? 1.5 : 0.82), 0, 100);
  emit(world, details.eventType || "combat-hit", `Здоровье ${Math.round(combat.health)}.`, attackerIndex >= 0 ? [targetIndex, attackerIndex] : [targetIndex], {
    sourcePlayer: attackerIndex,
    targetPlayer: targetIndex,
    weapon: details.weapon,
    heavy: Boolean(details.heavy),
    damage: amount,
    health: combat.health,
    x: target.x,
    y: target.y,
  });
  if (combat.health <= 0) {
    killPlayer(world, targetIndex, attackerIndex, helpers);
    return true;
  }
  if (details.heavy) knockDown(world, targetIndex, attackerIndex, 7.5, details.weapon);
  else if (combat.stun >= 34 && Math.floor(world.time * 10 + targetIndex * 7) % 3 === 0) {
    knockDown(world, targetIndex, attackerIndex, 3.5, details.weapon);
  }
  return true;
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
  combat.attackCooldown = heavy ? 0.72 : weapon === "knife" ? 0.36 : 0.3;
  const range = weapon === "knife" ? 6.4 : 5.2;
  const target = nearestTarget(world, attackerIndex, range, 105, false);
  emit(world, "combat-swing", "", [attackerIndex], {
    sourcePlayer: attackerIndex,
    weapon,
    heavy,
    x: attacker.x,
    y: attacker.y,
  });
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
  marauder.respawnAt = world.time + 36;
  emit(world, "marauder-destroyed", "Катер-мародёр уничтожен. На воде остался редкий ящик.", [0, 1], {
    sourcePlayer: attackerIndex,
    x: marauder.x,
    y: marauder.y,
  });
  helpers?.spawnRareCrate?.(world, marauder.x, marauder.y, "automatic", "marauder");
}

function fireAutomatic(world, attackerIndex, helpers) {
  const attacker = world.players[attackerIndex];
  const combat = attacker.combat;
  if (!combat.weapons.automatic || combat.ammo <= 0) {
    combat.equipped = combat.weapons.knife ? "knife" : "fists";
    emit(world, "gun-empty", "Патроны закончились. Выбраны кулаки.", [attackerIndex]);
    return;
  }
  combat.ammo -= 1;
  combat.attackCooldown = 0.13;
  const target = nearestTarget(world, attackerIndex, 96, 38, true);
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
  if (target.kind === "player") {
    damagePlayer(world, target.index, 11, attackerIndex, {
      weapon: "automatic",
      heavy: false,
      eventType: "gun-hit",
    }, helpers);
    return;
  }
  const marauder = target.point;
  marauder.hull = clamp(marauder.hull - 12, 0, 100);
  emit(world, "marauder-hit", `Корпус мародёра ${Math.round(marauder.hull)}.`, [attackerIndex], {
    sourcePlayer: attackerIndex,
    damage: 12,
    hull: marauder.hull,
    x: marauder.x,
    y: marauder.y,
  });
  if (marauder.hull <= 0) destroyMarauder(world, attackerIndex, helpers);
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
    combat.stun = clamp(combat.stun - dt * 8, 0, 100);
    if (combat.knockedDown) {
      combat.knockdownRemaining = Math.max(0, combat.knockdownRemaining - dt);
      if (combat.knockdownRemaining <= 0) {
        combat.knockedDown = false;
        emit(world, "player-rise", "Ты поднялся.", [index], {sourcePlayer: index, x: player.x, y: player.y});
      }
    }

    const injuryTarget = clamp((45 - combat.health) / 35, 0, 1);
    combat.injuryMix += (injuryTarget - combat.injuryMix) * Math.min(1, dt * 1.8);

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
      performMelee(world, index, held >= 0.5, helpers);
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
