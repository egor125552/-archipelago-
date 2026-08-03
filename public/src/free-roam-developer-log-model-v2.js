"use strict";

export function collectionValues(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

export function roundLogNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

export function compactLogValue(value, depth = 0) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return roundLogNumber(value, 3);
  if (depth >= 5) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 120).map(item => compactLogValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["audioBuffer", "buffer", "ctx", "socket"].includes(key)) continue;
    result[key] = compactLogValue(item, depth + 1);
  }
  return result;
}

function snapshot(kind, id, entity, extra = {}) {
  return {
    key: `${kind}:${id}`,
    kind,
    id: String(id),
    x: roundLogNumber(entity?.x),
    y: roundLogNumber(entity?.y),
    heading: roundLogNumber(entity?.heading),
    speed: roundLogNumber(entity?.speed),
    mode: entity?.mode ?? null,
    state: entity?.state ?? null,
    active: entity?.active ?? true,
    destroyed: entity?.destroyed ?? false,
    health: roundLogNumber(entity?.health),
    hull: roundLogNumber(entity?.hull),
    engineHealth: roundLogNumber(entity?.engineHealth),
    turretHealth: roundLogNumber(entity?.turretHealth),
    targetPlayer: Number.isInteger(Number(entity?.targetPlayer)) ? Number(entity.targetPlayer) : null,
    ...extra,
  };
}

export function activeEntitySnapshots(world) {
  const result = [];
  const players = collectionValues(world?.players);
  const boats = collectionValues(world?.boats);

  players.forEach((player, index) => {
    if (!player) return;
    result.push(snapshot("player", index, player, {
      alive: player.combat?.alive !== false,
      equipped: player.combat?.equipped || null,
      ammo: roundLogNumber(player.combat?.ammo, 0),
      pistolAmmo: roundLogNumber(player.combat?.pistolAmmo, 0),
      lockedTargetId: player.combat?.lockedTargetId || null,
      activeBoat: player.activeBoat ?? null,
      present: world?.freeActivities?.presence?.[index] !== false,
    }));
  });

  for (const boat of boats) {
    if (!boat || boat.sunk) continue;
    result.push(snapshot("player-boat", boat.id ?? "unknown", boat, {
      owner: boat.owner ?? null,
      driver: boat.driver ?? null,
      leak: roundLogNumber(boat.leak),
      fuel: roundLogNumber(boat.fuel),
    }));
  }

  const marauder = world?.freeActivities?.marauder;
  if (marauder?.active && !marauder.destroyed) {
    result.push(snapshot("enemy-boat", marauder.id || "pursuer-1", marauder, {role: "marauder"}));
  }
  for (const escort of collectionValues(world?.freePursuerSquad?.escorts)) {
    if (escort?.active && !escort.destroyed) result.push(snapshot("enemy-boat", escort.id, escort, {role: "escort"}));
  }
  for (const boat of collectionValues(world?.freeEnemyBoats?.boats)) {
    if (boat?.active && !boat.destroyed) result.push(snapshot("enemy-boat", boat.id, boat, {role: boat.role || null}));
  }
  for (const gunner of collectionValues(world?.freeHostileGunners?.gunners)) {
    if (gunner?.active && !gunner.destroyed) {
      result.push(snapshot("enemy-gunner", gunner.id, gunner, {pursuerId: gunner.pursuerId || null}));
    }
  }
  for (const actor of collectionValues(world?.freeHostileActors?.actors)) {
    if (actor?.active && !actor.destroyed) {
      result.push(snapshot("enemy-actor", actor.id, actor, {
        weapon: actor.weapon || null,
        elite: actor.elite === true,
        boatId: actor.boatId || null,
      }));
    }
  }

  const heavy = world?.freeHeavyPursuer?.boat;
  if (heavy?.active && !heavy.destroyed) {
    const diagnostics = world?.freeCombatDiagnostics?.heavy || {};
    result.push(snapshot("heavy-boat", heavy.id || "heavy-pursuer", heavy, {
      phase: diagnostics.phase ?? null,
      repairSystem: diagnostics.repairSystem ?? null,
      repairProgress: roundLogNumber(diagnostics.repairProgress),
      repairPlates: roundLogNumber(diagnostics.repairPlates, 0),
      tacticalMode: diagnostics.tacticalMode ?? null,
      suppressionPhase: diagnostics.suppressionPhase ?? null,
      destination: compactLogValue(diagnostics.destination ?? null),
    }));
  }
  return result;
}

export function entitySnapshotChanged(previous, next, now, heartbeatMs = 3000) {
  if (!previous) return true;
  const moved = Math.hypot((next.x || 0) - (previous.x || 0), (next.y || 0) - (previous.y || 0));
  const heading = Math.abs(((Number(next.heading) || 0) - (Number(previous.heading) || 0) + 540) % 360 - 180);
  const speed = Math.abs((Number(next.speed) || 0) - (Number(previous.speed) || 0));
  const structural = [
    "mode", "state", "active", "destroyed", "alive", "health", "hull", "engineHealth", "turretHealth",
    "targetPlayer", "equipped", "ammo", "pistolAmmo", "lockedTargetId", "activeBoat", "present",
    "phase", "repairSystem", "repairProgress", "repairPlates", "tacticalMode", "suppressionPhase", "destination",
  ].some(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
  return structural || moved >= 1.4 || heading >= 7 || speed >= 0.8 || now - (previous.loggedAt || 0) >= heartbeatMs;
}
