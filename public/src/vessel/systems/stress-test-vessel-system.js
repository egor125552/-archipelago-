"use strict";

// This late-bound runtime import is intentional: vessel-runtime installs this
// plugin while it is initializing, but spawnVessel is only called later from a
// gameplay phase, after the runtime module has completed initialization.
import {spawnVessel} from "../vessel-runtime.js?v=2";
import {
  STRESS_TEST_START_AMMO,
  STRESS_TEST_VESSEL_TYPE,
} from "../stress-test-vessel-config.js?v=2";
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
const suppressedAttackByWorld = new WeakMap();

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 240) world.events.splice(0, world.events.length - 240);
}

function isStressBoat(boat) {
  return Boolean(boat && (boat.vesselType === STRESS_TEST_VESSEL_TYPE || boat.boatType === STRESS_TEST_VESSEL_TYPE));
}

function testBoat(world) {
  return (world?.boats || []).find(isStressBoat) || null;
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

function suppressAttackForBaseStep(world, playerIndex) {
  const saved = inputObjects(world, playerIndex).map(input => [input, input.attack]);
  for (const [input] of saved) input.attack = false;
  const groups = suppressedAttackByWorld.get(world) || [];
  groups.push({playerIndex, saved});
  suppressedAttackByWorld.set(world, groups);
}

function restoreSuppressedAttacks(world) {
  const groups = suppressedAttackByWorld.get(world) || [];
  suppressedAttackByWorld.delete(world);
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const {playerIndex, saved} = groups[groupIndex];
    const held = saved.some(([, value]) => value === true);
    for (let index = saved.length - 1; index >= 0; index -= 1) {
      const [input, value] = saved[index];
      input.attack = value;
    }
    // world.inputs is the legacy movement store and older layers omit attack
    // when copying input. Mirror the held bit only for this step so legacy
    // observers/tests see the same authoritative hold state; the next input
    // delivery remains the source of truth and may clear it normally.
    if (held && world?.inputs?.[playerIndex]) world.inputs[playerIndex].attack = true;
  }
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

function damageTarget(world, target, amount, sourcePlayer, weapon, sourcePoint) {
  if (!target) return false;
  if (target.kind === "player") {
    return applyCombatDamage(world, target.playerIndex, amount, sourcePlayer, {
      weapon,
      heavy: false,
      eventType: "vessel-mounted-player-hit",
      sourcePoint,
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
    if (!player || player.mode !== "boat" || player.activeBoat !== boat.id) continue;
    const input = currentInput(world, playerIndex);
    if (!input.attack) continue;

    // The mounted pistol owns the attack input while the player is driving this
    // vessel. Suppress it only for the inherited common step, then restore it in
    // after-step so a held key/touch remains held on the server and can fire the
    // next 40 ms shot instead of becoming a one-shot pulse.
    suppressAttackForBaseStep(world, playerIndex);
    if (player.combat?.alive === false) continue;
    if (boat.sunk || mounted.state.enabled === false || (Number(mounted.state.health) || 0) <= 0) continue;

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
    const applied = target ? Boolean(damageTarget(world, target, damage,playerIndex, weapon, boat)) : false;

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
    if (event?.type !== "enter") continue;
    const boat = (world.boats || []).find(candidate => candidate?.id === event.boatId) || null;
    if (!isStressBoat(boat)) continue;
    const ammo = Math.max(0, Math.floor(Number(boat?.testWeaponAmmo) || STRESS_TEST_START_AMMO));
    event.boatType = STRESS_TEST_VESSEL_TYPE;
    const ownership = event.ownedBoat === false
      ? "Ты сел в испытательный катер другого игрока «Пятьдесят»."
      : event.claimedBoat
        ? "Ты занял свободный испытательный катер «Пятьдесят»; теперь он твой."
        : "Ты сел в свой испытательный катер «Пятьдесят».";
    event.text = `${ownership} Здесь 50 двигателей. Сверхскоростной пистолет: ${ammo} патронов. Удерживай огонь.`;
  }
}

export const STRESS_TEST_VESSEL_SYSTEMS = Object.freeze([
  Object.freeze({
    id: "stress-test-vessel-spawner-v2",
    phase: "before-step",
    order: -100,
    run({world}) {
      if (world) ensureTestBoat(world);
    },
  }),
  Object.freeze({
    id: "stress-test-mounted-pistol-v2",
    phase: "before-step",
    order: 10,
    run: updateMountedWeapons,
  }),
  Object.freeze({
    id: "stress-test-boarding-announcer-v3",
    phase: "after-step",
    order: 20,
    run: announceBoarding,
  }),
  Object.freeze({
    id: "stress-test-held-attack-restore-v2",
    phase: "after-step",
    order: 90,
    run({world}) {
      if (world) restoreSuppressedAttacks(world);
    },
  }),
]);
