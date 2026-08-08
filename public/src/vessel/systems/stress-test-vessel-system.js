"use strict";

// This late-bound runtime import is intentional: vessel-runtime installs this
// plugin while it is initializing, but spawnVessel is only called later from a
// gameplay phase, after the runtime module has completed initialization.
import {spawnVessel} from "../vessel-runtime.js?v=2";
import {
  STRESS_TEST_START_AMMO,
  STRESS_TEST_VESSEL_TYPE,
} from "../stress-test-vessel-config.js?v=1";
import {listCombatTargets, resolveCombatTarget} from "../../free-roam-targeting.js?v=39";
import {applyBoatDamage} from "../../collision-model.js";
import {applyCombatDamage} from "../../free-roam-combat-v2.js?v=6";
import {damageEnemyBoat} from "../../free-roam-enemy-boats.js?v=3";
import {damageEscort} from "../../free-roam-pursuer-squad.js?v=33";
import {damageHostileGunner} from "../../free-roam-hostile-gunners.js?v=32";
import {damageHostileActor} from "../../free-roam-hostile-actors.js?v=3";
import {damageHeavyPursuer} from "../../free-roam-heavy-pursuer.js?v=4";
import {damageEliteBoatBoss} from "../../free-roam-elite-boat.js?v=2";
import {releaseStolenCargo} from "../../free-roam-marauder.js?v=33";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const rad = value => Number(value) * Math.PI / 180;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 240) world.events.splice(0, world.events.length - 240);
}

function testBoat(world) {
  return (world?.boats || []).find(boat => boat && (
    boat.vesselType === STRESS_TEST_VESSEL_TYPE || boat.boatType === STRESS_TEST_VESSEL_TYPE
  )) || null;
}

function ensureTestBoat(world) {
  const existing = testBoat(world);
  if (existing) return existing;
  const {boat} = spawnVessel(world, STRESS_TEST_VESSEL_TYPE, {
    x: 210,
    y: 132,
    heading: 180,
    state: {
      x: 210,
      y: 132,
      heading: 180,
      driver: null,
      crew: [],
      reserved: false,
      connectionActivated: true,
    },
  });
  emit(
    world,
    "stress-vessel-spawned",
    "У причала готов испытательный катер «Пятьдесят»: 50 двигателей и сверхскоростной пистолет на 10000 патронов.",
    [0, 1],
    {boatId: boat.id, boatType: boat.boatType, audioProfile: boat.audioProfile, x: boat.x, y: boat.y},
  );
  return boat;
}

function inputObjects(world, playerIndex) {
  return [...new Set([
    world?.freeActivities?.inputs?.[playerIndex],
    world?.operationInputs?.[playerIndex],
    world?.inputs?.[playerIndex],
  ].filter(Boolean))];
}

function currentInput(world, playerIndex) {
  return {
    ...(world?.freeActivities?.inputs?.[playerIndex] || {}),
    ...(world?.operationInputs?.[playerIndex] || {}),
    ...(world?.inputs?.[playerIndex] || {}),
  };
}

function consumeAttack(world, playerIndex) {
  for (const input of inputObjects(world, playerIndex)) input.attack = false;
}

function targetAllowed(world, boat, target) {
  if (!target) return false;
  if (target.kind === "boat" && target.boatId === boat.id) return false;
  if (target.kind === "player" && world.players?.[target.playerIndex]?.activeBoat === boat.id) return false;
  return true;
}

function selectTarget(world, playerIndex, boat, range) {
  const combat = world.players?.[playerIndex]?.combat;
  const locked = resolveCombatTarget(world, playerIndex, combat?.lockedTargetId, range);
  if (locked && targetAllowed(world, boat, locked)) return locked;
  if (combat?.lockedTargetId) combat.lockedTargetId = null;
  const automatic = listCombatTargets(world, playerIndex, range)
    .find(target => targetAllowed(world, boat, target) && !["player", "boat"].includes(target.kind)) || null;
  if (automatic && combat) combat.lockedTargetId = automatic.id;
  return automatic;
}

function destroyMarauder(world, target, sourcePlayer, weapon) {
  const marauder = target?.point;
  if (!marauder || marauder.destroyed) return false;
  marauder.hull = 0;
  marauder.destroyed = true;
  marauder.active = false;
  marauder.speed = 0;
  releaseStolenCargo(world, marauder);
  emit(world, "pursuer-destroyed", "Катер-преследователь уничтожен испытательным пистолетом.", [0, 1], {
    sourcePlayer,
    weapon,
    x: marauder.x,
    y: marauder.y,
  });
  return true;
}

function damageTarget(world, target, amount, sourcePlayer, weapon) {
  if (!target) return false;
  if (target.kind === "player") {
    return applyCombatDamage(world, target.playerIndex, amount, sourcePlayer, {
      weapon,
      heavy: false,
      eventType: "vessel-mounted-player-hit",
      sourcePoint: target.point,
    }, {});
  }
  if (target.kind === "boat") return applyBoatDamage(target.point, amount, {armorShare: 0.72, leakShare: 0.045}).damage > 0;
  if (target.kind === "gunner") return damageHostileGunner(world, target.gunnerId, amount, sourcePlayer);
  if (["hostileActor", "elite"].includes(target.kind)) return damageHostileActor(world, target.actorId, amount, sourcePlayer, {weapon});
  if (target.kind === "escort") return damageEscort(world, target.pursuerId, amount, sourcePlayer, {});
  if (target.kind === "enemyBoat") return damageEnemyBoat(world, target.enemyBoatId, amount, sourcePlayer, {}, {weapon});
  if (["heavyHull", "heavyTurret", "heavyEngine"].includes(target.kind)) {
    return damageHeavyPursuer(world, target.component || "hull", amount, sourcePlayer, {}, {weapon});
  }
  if (["eliteArmor", "eliteHull", "eliteTurret", "eliteBombBay"].includes(target.kind)) {
    return damageEliteBoatBoss(world, target.component || "hull", amount, sourcePlayer, {weapon, turretId: target.turretId});
  }
  if (target.kind === "marauder") {
    target.point.hull = Math.max(0, (Number(target.point.hull) || 0) - amount);
    if (target.point.hull <= 0) destroyMarauder(world, target, sourcePlayer, weapon);
    return true;
  }
  return false;
}

function targetBearing(from, target) {
  return Math.atan2((Number(target?.x) || 0) - (Number(from?.x) || 0), -((Number(target?.y) || 0) - (Number(from?.y) || 0))) * 180 / Math.PI;
}

function emptyImpact(boat, heading, range) {
  const direction = rad(heading);
  return {
    x: Number(boat.x) + Math.sin(direction) * range,
    y: Number(boat.y) - Math.cos(direction) * range,
  };
}

function stressMountedWeapon(entry) {
  const definition = entry?.definition?.modules?.find(module => (
    module?.type === "mounted-weapon" && module?.config?.inputMode === "driver-attack"
  ));
  if (!definition) return null;
  const state = entry.instance?.modules?.[definition.id];
  return state ? {definition, state} : null;
}

function updateMountedWeapons(context) {
  const world = context?.world;
  const safeDt = clamp(context?.dt, 0, 0.1);
  if (!world) return;

  for (const entry of context.nativeVessels || []) {
    if (entry?.definition?.id !== STRESS_TEST_VESSEL_TYPE) continue;
    const boat = entry.boat;
    const mounted = stressMountedWeapon(entry);
    if (!boat || !mounted) continue;
    if (!mounted.state.stressAmmoHydrated) {
      const persistedAmmo = Number(boat.testWeaponAmmo);
      if (Number.isFinite(persistedAmmo) && persistedAmmo >= 0) mounted.state.ammo = Math.floor(persistedAmmo);
      mounted.state.stressAmmoHydrated = true;
    }
    mounted.state.cooldown = Math.max(0, (Number(mounted.state.cooldown) || 0) - safeDt);
    boat.testWeaponAmmo = Math.max(0, Math.floor(Number(mounted.state.ammo) || 0));

    const playerIndex = Number.isInteger(boat.driver) ? boat.driver : null;
    const player = Number.isInteger(playerIndex) ? world.players?.[playerIndex] : null;
    if (!player || player.mode !== "boat" || player.activeBoat !== boat.id || player.combat?.alive === false) continue;
    const input = currentInput(world, playerIndex);
    if (!input.attack) continue;
    consumeAttack(world, playerIndex);
    if (boat.sunk || boat.engineStalled || mounted.state.enabled === false || (Number(mounted.state.health) || 0) <= 0) continue;

    if (mounted.state.ammo <= 0) {
      const now = Number(world.time) || 0;
      if (now - (Number(mounted.state.lastDeniedAt) || -999) >= 1.2) {
        mounted.state.lastDeniedAt = now;
        emit(world, "action-denied", "В сверхскоростном пистолете закончились патроны.", [playerIndex], {sourcePlayer: playerIndex, boatId: boat.id});
      }
      continue;
    }
    if (mounted.state.cooldown > 0) continue;

    const config = mounted.definition.config || {};
    const range = Math.max(10, Number(config.range) || 620);
    const damage = Math.max(0.1, Number(config.damage) || 12);
    const interval = Math.max(0.04, Number(config.interval) || 0.04);
    const weapon = String(config.weaponId || mounted.definition.id);
    const target = selectTarget(world, playerIndex, boat, range);
    const heading = target ? targetBearing(boat, target.point) : Number(boat.heading) || 0;
    const fallbackImpact = emptyImpact(boat, heading, range);
    const impactX = Number.isFinite(Number(target?.point?.x)) ? Number(target.point.x) : fallbackImpact.x;
    const impactY = Number.isFinite(Number(target?.point?.y)) ? Number(target.point.y) : fallbackImpact.y;
    const applied = target ? Boolean(damageTarget(world, target, damage, playerIndex, weapon)) : false;

    mounted.state.ammo = Math.max(0, Math.floor(Number(mounted.state.ammo) || 0) - 1);
    mounted.state.cooldown = interval;
    boat.testWeaponAmmo = mounted.state.ammo;
    emit(world, "vessel-mounted-shot", "", [0, 1], {
      sourcePlayer: playerIndex,
      boatId: boat.id,
      boatType: boat.boatType,
      audioProfile: boat.audioProfile,
      moduleId: mounted.definition.id,
      weapon,
      ammo: mounted.state.ammo,
      damage,
      instant: true,
      hit: Boolean(target),
      applied,
      targetId: target?.id ?? null,
      targetKind: target?.kind ?? null,
      heading,
      x: boat.x,
      y: boat.y,
      impactX,
      impactY,
    });
  }
}

function announceBoarding(context) {
  const world = context?.world;
  if (!world) return;
  for (const event of (world.events || []).slice(context.eventStart || 0)) {
    if (event?.type !== "enter" || event.boatType !== STRESS_TEST_VESSEL_TYPE) continue;
    const boat = (world.boats || []).find(candidate => candidate?.id === event.boatId) || testBoat(world);
    const ammo = Math.max(0, Math.floor(Number(boat?.testWeaponAmmo) || STRESS_TEST_START_AMMO));
    event.text = `Ты сел в испытательный катер «Пятьдесят». Здесь 50 двигателей. Сверхскоростной пистолет: ${ammo} патронов. Удерживай огонь.`;
  }
}

export const STRESS_TEST_VESSEL_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "stress-test-vessel-spawner-v1",
    phase: "before-step",
    order: -100,
    run({world}) {
      if (world) ensureTestBoat(world);
    },
  }),
  Object.freeze({
    id: "stress-test-mounted-pistol-v1",
    phase: "before-step",
    order: 10,
    run: updateMountedWeapons,
  }),
  Object.freeze({
    id: "stress-test-boarding-announcer-v1",
    phase: "after-input",
    order: 20,
    run: announceBoarding,
  }),
]);
