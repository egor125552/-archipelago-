"use strict";

function select(source, keys) {
  if (!source) return source ?? null;
  const result = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  return result;
}

function compact(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : 0;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(compact);
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = compact(child);
  return result;
}

const REPLACE_KEY = "$replace";
const DELETE_KEY = "$delete";

function cloneValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneValue(child);
  return result;
}

function deltaNode(previous, next) {
  if (Object.is(previous, next)) return undefined;
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object") {
    return cloneValue(next);
  }
  if (Array.isArray(previous) !== Array.isArray(next)) return {[REPLACE_KEY]: cloneValue(next)};
  if (Array.isArray(next) && previous.length !== next.length) return {[REPLACE_KEY]: cloneValue(next)};

  const delta = {};
  const keys = Array.isArray(next)
    ? next.map((_, index) => String(index))
    : [...new Set([...Object.keys(previous), ...Object.keys(next)])];
  for (const key of keys) {
    if (!Object.hasOwn(next, key)) {
      delta[key] = {[DELETE_KEY]: true};
      continue;
    }
    const child = deltaNode(previous[key], next[key]);
    if (child !== undefined) delta[key] = child;
  }
  if (Array.isArray(next) && Object.keys(delta).length) {
    const replacement = {[REPLACE_KEY]: cloneValue(next)};
    if (JSON.stringify(delta).length >= JSON.stringify(replacement).length) return replacement;
  }
  return Object.keys(delta).length ? delta : undefined;
}

function applyDeltaNode(previous, delta) {
  if (!delta || typeof delta !== "object") return cloneValue(delta);
  if (delta && typeof delta === "object" && Object.hasOwn(delta, REPLACE_KEY)) {
    return cloneValue(delta[REPLACE_KEY]);
  }
  const result = Array.isArray(previous) ? previous.map(cloneValue) : cloneValue(previous || {});
  for (const [key, child] of Object.entries(delta || {})) {
    if (child && typeof child === "object" && child[DELETE_KEY]) {
      if (Array.isArray(result)) result.splice(Number(key), 1);
      else delete result[key];
      continue;
    }
    result[key] = applyDeltaNode(previous?.[key], child);
  }
  return result;
}

export function diffReplicatedWorld(previous, next) {
  return deltaNode(previous, next) || {};
}

export function applyReplicatedWorldDelta(previous, delta) {
  if (!previous) return null;
  return applyDeltaNode(previous, delta || {});
}

const BOAT_FIELDS = Object.freeze([
  "id", "owner", "driver", "x", "y", "heading", "speed", "throttle", "rudder",
  "hull", "armor", "armorMax", "water", "leak", "fuel", "engineTemp",
  "engineStalled", "pumpActive", "repairPatches", "hullRepairProgress",
  "emergencyActive", "emergencyRemaining", "restartProgress", "sunk", "moving",
  "floatingBrakeReadyAt", "refuelCanisters", "refuelActive", "refuelProgress",
  "engineServiceActive", "engineServiceProgress", "cargo", "cargoWeight", "cargoPumpBonus",
]);
const PLAYER_FIELDS = Object.freeze([
  "id", "mode", "activeBoat", "x", "y", "heading", "running", "airborne", "jumpHeight",
]);
const COMBAT_FIELDS = Object.freeze([
  "health", "alive", "respawnRemaining", "knockedDown", "knockdownRemaining", "stun",
  "stamina", "carriedCrate", "weapons", "equipped", "ammo", "pistolAmmo", "injuryMix", "lockedTargetId",
]);
const PURSUER_FIELDS = Object.freeze([
  "id", "x", "y", "heading", "speed", "hull", "maxHull", "active", "destroyed", "targetPlayer",
]);
const GUNNER_FIELDS = Object.freeze([
  "id", "pursuerId", "targetPlayer", "x", "y", "heading", "health", "active", "destroyed", "returning",
]);
const ENEMY_BOAT_FIELDS = Object.freeze([
  "id", "role", "x", "y", "heading", "speed", "hull", "maxHull", "active", "destroyed", "targetPlayer", "crewSeats",
]);
const HEAVY_FIELDS = Object.freeze([
  "id", "role", "x", "y", "heading", "turretHeading", "speed", "hull", "maxHull", "engineHealth", "maxEngineHealth", "turretHealth", "maxTurretHealth",
  "engineDisabled", "turretDisabled", "active", "destroyed", "targetPlayer", "burstRemaining", "aimRemaining",
]);
const HOSTILE_ACTOR_FIELDS = Object.freeze([
  "id", "boatId", "targetPlayer", "x", "y", "heading", "state", "weapon", "health", "maxHealth", "active", "destroyed", "elite",
]);
const CRATE_FIELDS = Object.freeze([
  "id", "kind", "label", "rarity", "weight", "slots", "traits", "x", "y", "state", "carriedBy", "stowedBoat", "source",
  "contractId", "contractDefinitionId", "contractCategory", "contractDamage", "waterExposure",
  "extractionSeconds", "extractionProgress", "extracted",
]);

// Browsers render this view but never own the authoritative simulation. Host
// inputs, collision caches, AI cooldowns and projectile physics stay inside
// the Durable Object and can no longer flood a slower browser.
export function replicatedFreeWorld(world) {
  const activities = world?.freeActivities || {};
  const scenario = world?.freeScenario || {};
  const pursuers = world?.freePursuerSquad || {};
  const gunners = world?.freeHostileGunners || {};
  const enemyBoats = world?.freeEnemyBoats || {};
  const hostileActors = world?.freeHostileActors || {};
  const threat = world?.freeThreatDirector || {};
  const heavy = world?.freeHeavyPursuer || {};
  return compact({
    version: world?.version,
    time: world?.time,
    boats: (world?.boats || []).map(boat => select(boat, BOAT_FIELDS)),
    players: (world?.players || []).map(player => ({
      ...select(player, PLAYER_FIELDS),
      combat: select(player?.combat, COMBAT_FIELDS),
    })),
    tow: world?.tow ?? null,
    freeActivities: {
      presence: activities.presence,
      score: activities.score,
      delivered: activities.delivered,
      credits: activities.credits,
      shopOpen: activities.shopOpen,
      shopSelection: activities.shopSelection,
      crates: (activities.crates || []).map(crate => select(crate, CRATE_FIELDS)),
      marauder: select(activities.marauder, PURSUER_FIELDS),
    },
    freeScenario: select(scenario, [
      "phase", "warningUntil", "targets", "lockedTargetIds", "beaconUntil", "guideEnabled", "navigationModes",
    ]),
    freeContracts: world?.freeContracts ? {
      offerIds: (world.freeContracts.offers || []).map(offer => offer.definitionId),
      activeContract: select(world.freeContracts.activeContract, [
        "id", "definitionId", "category", "label", "phase", "creditReward", "scrapReward", "bonus",
        "threat", "maximumThreat", "crateId", "rewardIssued",
      ]),
      completedContracts: world.freeContracts.completedContracts,
      abandonedContracts: world.freeContracts.abandonedContracts,
      scrap: world.freeContracts.scrap,
      boardOpen: world.freeContracts.boardOpen,
      boardSelection: world.freeContracts.boardSelection,
      encounterActive: world.freeContracts.encounterActive,
      encounterLevel: world.freeContracts.encounterLevel,
      encounterDefeated: world.freeContracts.encounterDefeated,
    } : null,
    freePursuerSquad: {
      activated: pursuers.activated,
      assignments: pursuers.assignments,
      escorts: (pursuers.escorts || []).map(escort => select(escort, PURSUER_FIELDS)),
      projectiles: (pursuers.projectiles || []).map(projectile => select(projectile, ["id", "x", "y"])),
    },
    freeHostileGunners: {
      gunners: (gunners.gunners || []).map(gunner => select(gunner, GUNNER_FIELDS)),
      projectiles: (gunners.projectiles || []).map(projectile => select(projectile, ["id", "x", "y"])),
    },
    freeEnemyBoats: enemyBoats.active || (enemyBoats.boats || []).length ? {
      active: enemyBoats.active,
      level: enemyBoats.level,
      boats: (enemyBoats.boats || []).map(boat => select(boat, ENEMY_BOAT_FIELDS)),
      projectiles: (enemyBoats.projectiles || []).map(projectile => select(projectile, ["id", "x", "y"])),
    } : null,
    freeHostileActors: hostileActors.active || (hostileActors.actors || []).length ? {
      active: hostileActors.active,
      level: hostileActors.level,
      actors: (hostileActors.actors || []).map(actor => select(actor, HOSTILE_ACTOR_FIELDS)),
      projectiles: (hostileActors.projectiles || []).map(projectile => select(projectile, ["id", "x", "y"])),
    } : null,
    freeThreatDirector: threat.active || threat.level ? select(threat, [
      "active", "level", "encounterId", "contractId", "assignments", "graceUntil", "rewardIssued", "cleared",
    ]) : null,
    ...(heavy.active || heavy.boat ? {freeHeavyPursuer: {
      active: heavy.active,
      encounterId: heavy.encounterId,
      boat: select(heavy.boat, HEAVY_FIELDS),
      projectiles: (heavy.projectiles || []).map(projectile => select(projectile, ["id", "x", "y"])),
    }} : {}),
  });
}
