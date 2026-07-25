"use strict";

import {CARGO_ACTION_RANGE, isFootDockZone} from "./free-roam-cargo-rules.js?v=32";
import {cargoSlotCost} from "./free-roam-cargo-traits.js?v=1";

const BRAKE_COOLDOWN_SECONDS = 12;
const SHORE_Y = 72;

const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function nearestBoat(world, point, maximum = Infinity) {
  let found = null;
  let best = maximum;
  for (const boat of world?.boats || []) {
    if (!boat || boat.sunk) continue;
    const metres = distance(point, boat);
    if (metres < best) {
      best = metres;
      found = boat;
    }
  }
  return {boat: found, distance: best};
}

function crateById(world, id) {
  return (world?.freeActivities?.crates || []).find(crate => crate?.id === id) || null;
}

function nearestWorldCrate(world, point, maximum = CARGO_ACTION_RANGE) {
  let found = null;
  let best = maximum;
  for (const crate of world?.freeActivities?.crates || []) {
    if (!crate || crate.state !== "world") continue;
    const metres = distance(point, crate);
    if (metres <= best + 0.001) {
      best = metres;
      found = crate;
    }
  }
  return {crate: found, distance: best};
}

function occupiedCargoSlots(world, boat) {
  return (boat?.cargo || []).reduce((sum, id) => sum + cargoSlotCost(crateById(world, id)), 0);
}

function canStow(world, boat, crate) {
  return Boolean(
    boat
    && crate
    && !boat.sunk
    && occupiedCargoSlots(world, boat) + cargoSlotCost(crate) <= 5
  );
}

function labelFor(crate) {
  return crate?.label || ({
    plates: "ремонтные пластины",
    fuel: "топливо",
    pump: "усилитель насоса",
    valuable: "ценный груз",
    knife: "нож",
    automatic: "автомат",
    ammo: "патроны",
  })[crate?.kind] || "груз";
}

function cueOnly(cue = "action") {
  return {
    type: "cue-only",
    cue,
    expiryMs: 900,
    suppressEvents: [],
    announcement: "",
  };
}

function jumpPrediction(world, playerIndex, startedAtMs) {
  const player = world?.players?.[playerIndex];
  if (!player?.combat?.alive || player.combat.knockedDown) return cueOnly("deny");

  if (player.mode === "boat") {
    const boat = world?.boats?.[player.activeBoat];
    if (!boat || boat.sunk) return cueOnly("deny");
    const remaining = (Number(boat.floatingBrakeReadyAt) || 0) - (Number(world?.time) || 0);
    const moving = Math.abs(Number(boat.speed) || 0) > 0.16 || Math.abs(Number(boat.throttle) || 0) >= 0.05;
    if (remaining > 0 || !moving) return cueOnly("deny");
    return {
      type: "brake",
      cue: "brake",
      playerIndex,
      boatId: boat.id,
      startedAtMs,
      expiryMs: 1_500,
      suppressEvents: ["anchor"],
      announcement: "Плавучий тормоз.",
    };
  }

  if (player.mode === "roof") {
    const boat = world?.boats?.[player.activeBoat];
    if (!boat) return cueOnly("deny");
    return {
      type: "roof-dismount",
      cue: "roof",
      playerIndex,
      boatId: boat.id,
      startedAtMs,
      expiryMs: 1_500,
      suppressEvents: ["jump"],
      announcement: boat.y <= SHORE_Y + 20
        ? "Ты спрыгнул с крыши на берег."
        : "Ты спрыгнул с крыши в воду.",
    };
  }

  if (["foot", "swim"].includes(player.mode)) {
    const nearby = nearestBoat(world, player, 10);
    if (nearby.boat) {
      return {
        type: "roof-climb",
        cue: "roof",
        playerIndex,
        boatId: nearby.boat.id,
        startedAtMs,
        expiryMs: 1_500,
        suppressEvents: ["roof"],
        announcement: "Ты запрыгнул на крышу лодки.",
      };
    }
    if (player.mode === "foot" && !player.airborne) {
      return {
        type: "jump",
        cue: "jump",
        playerIndex,
        startedAtMs,
        expiryMs: 1_100,
        suppressEvents: ["jump"],
        announcement: "Прыжок.",
      };
    }
  }

  return cueOnly("deny");
}

function cargoPrediction(world, playerIndex, startedAtMs) {
  const player = world?.players?.[playerIndex];
  const combat = player?.combat;
  if (!player || !combat?.alive || combat.knockedDown) return cueOnly("deny");

  const carried = crateById(world, combat.carriedCrate);
  if (carried) {
    if (isFootDockZone(player)) return cueOnly("action");

    const other = world?.players?.[1 - playerIndex];
    const otherPresent = world?.freeActivities?.presence?.[1 - playerIndex] !== false;
    if (otherPresent && other?.combat?.alive && !other.combat.carriedCrate && distance(player, other) <= 4.5) {
      return cueOnly("action");
    }

    const nearby = nearestBoat(world, player, 11);
    if (canStow(world, nearby.boat, carried)) {
      return {
        type: "cargo-stow",
        cue: "cargo-stow",
        playerIndex,
        crateId: carried.id,
        boatId: nearby.boat.id,
        startedAtMs,
        expiryMs: 1_700,
        suppressEvents: ["cargo-stowed"],
        announcement: `Ящик погружён на лодку: ${labelFor(carried)}.`,
      };
    }

    return {
      type: "cargo-drop",
      cue: "cargo-drop",
      playerIndex,
      crateId: carried.id,
      startedAtMs,
      expiryMs: 1_700,
      suppressEvents: ["cargo-drop"],
      announcement: "Ты положил груз рядом.",
    };
  }

  const nearest = nearestWorldCrate(world, player);
  if (!nearest.crate) return cueOnly("action");
  if (nearest.crate.contractCategory === "salvage" && !nearest.crate.extracted) return cueOnly("action");

  if (player.mode === "boat") {
    const boat = world?.boats?.[player.activeBoat];
    if (!canStow(world, boat, nearest.crate)) return cueOnly("deny");
    return {
      type: "cargo-stow",
      cue: "cargo-stow",
      playerIndex,
      crateId: nearest.crate.id,
      boatId: boat.id,
      startedAtMs,
      expiryMs: 1_700,
      suppressEvents: ["cargo-stowed"],
      announcement: `Ящик погружён на лодку: ${labelFor(nearest.crate)}.`,
    };
  }

  return {
    type: "cargo-pickup",
    cue: "cargo-pickup",
    playerIndex,
    crateId: nearest.crate.id,
    startedAtMs,
    expiryMs: 1_700,
    suppressEvents: ["cargo-pickup"],
    announcement: `Ты поднял: ${labelFor(nearest.crate)}.`,
  };
}

export function createLocalActionPrediction(world, playerIndex, actionName, startedAtMs = performance.now()) {
  if (!world) return null;
  if (actionName === "jump") return jumpPrediction(world, playerIndex, startedAtMs);
  if (actionName === "action") return cargoPrediction(world, playerIndex, startedAtMs);
  return null;
}

function applyJump(world, prediction, nowMs) {
  const player = world?.players?.[prediction.playerIndex];
  if (!player || player.mode !== "foot") return false;
  const elapsed = Math.max(0, (Number(nowMs) - Number(prediction.startedAtMs)) / 1_000);
  const velocity = 5.8 - 15.5 * elapsed;
  const height = 0.04 + 5.8 * elapsed - 7.75 * elapsed * elapsed;
  if (height <= 0 && velocity < 0) {
    player.airborne = false;
    player.jumpHeight = 0;
    player.__localJumpVelocity = 0;
    return true;
  }
  player.airborne = true;
  player.jumpHeight = Math.max(0.04, height);
  player.__localJumpVelocity = velocity;
  return true;
}

function applyRoofClimb(world, prediction) {
  const player = world?.players?.[prediction.playerIndex];
  const boat = world?.boats?.find(candidate => candidate?.id === prediction.boatId);
  if (!player || !boat || boat.sunk) return false;
  player.mode = "roof";
  player.activeBoat = boat.id;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  return true;
}

function applyRoofDismount(world, prediction) {
  const player = world?.players?.[prediction.playerIndex];
  const boat = world?.boats?.find(candidate => candidate?.id === prediction.boatId);
  if (!player || !boat) return false;
  player.mode = boat.y <= SHORE_Y + 20 ? "foot" : "swim";
  player.activeBoat = null;
  player.x = (Number(boat.x) || Number(player.x) || 0) + 7;
  player.y = player.mode === "foot" ? SHORE_Y - 5 : (Number(boat.y) || Number(player.y) || 0) + 8;
  player.airborne = false;
  player.jumpHeight = 0;
  return true;
}

function applyBrake(world, prediction) {
  const player = world?.players?.[prediction.playerIndex];
  const boat = world?.boats?.find(candidate => candidate?.id === prediction.boatId);
  if (!player || !boat || player.mode !== "boat" || player.activeBoat !== boat.id) return false;
  const direction = Math.sign(Number(boat.speed) || 0);
  boat.speed = direction * Math.min(0.12, Math.abs(Number(boat.speed) || 0) * 0.08);
  boat.throttle = 0;
  boat.rudder = 0;
  boat.floatingBrakeReadyAt = (Number(world?.time) || 0) + BRAKE_COOLDOWN_SECONDS;
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
  return true;
}

function applyCargoPickup(world, prediction) {
  const player = world?.players?.[prediction.playerIndex];
  const crate = crateById(world, prediction.crateId);
  if (!player?.combat || !crate || crate.state !== "world") return false;
  crate.state = "carried";
  crate.carriedBy = prediction.playerIndex;
  crate.stowedBoat = null;
  crate.x = player.x;
  crate.y = player.y;
  player.combat.carriedCrate = crate.id;
  return true;
}

function applyCargoStow(world, prediction) {
  const player = world?.players?.[prediction.playerIndex];
  const crate = crateById(world, prediction.crateId);
  const boat = world?.boats?.find(candidate => candidate?.id === prediction.boatId);
  if (!player?.combat || !crate || !canStow(world, boat, crate)) return false;
  boat.cargo ||= [];
  if (!boat.cargo.includes(crate.id)) boat.cargo.push(crate.id);
  crate.state = "stowed";
  crate.carriedBy = null;
  crate.stowedBoat = boat.id;
  crate.x = boat.x;
  crate.y = boat.y;
  player.combat.carriedCrate = null;
  return true;
}

function applyCargoDrop(world, prediction) {
  const player = world?.players?.[prediction.playerIndex];
  const crate = crateById(world, prediction.crateId);
  if (!player?.combat || !crate) return false;
  crate.state = "world";
  crate.carriedBy = null;
  crate.stowedBoat = null;
  crate.x = Number(player.x) || 210;
  crate.y = Number(player.y) || 62;
  player.combat.carriedCrate = null;
  return true;
}

export function applyLocalActionPrediction(world, prediction, nowMs = performance.now()) {
  if (!world || !prediction) return false;
  switch (prediction.type) {
    case "jump": return applyJump(world, prediction, nowMs);
    case "roof-climb": return applyRoofClimb(world, prediction);
    case "roof-dismount": return applyRoofDismount(world, prediction);
    case "brake": return applyBrake(world, prediction);
    case "cargo-pickup": return applyCargoPickup(world, prediction);
    case "cargo-stow": return applyCargoStow(world, prediction);
    case "cargo-drop": return applyCargoDrop(world, prediction);
    default: return false;
  }
}

export function localActionPredictionExpired(prediction, nowMs = performance.now()) {
  const age = Math.max(0, Number(nowMs) - Number(prediction?.startedAtMs));
  return age > Math.max(250, Number(prediction?.expiryMs) || 1_500);
}
