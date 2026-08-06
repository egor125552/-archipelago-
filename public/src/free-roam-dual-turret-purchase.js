"use strict";

import {
  DUAL_TURRET_PRICE,
} from "./free-roam-dual-turret-config.js";
import {dualTurretBoat} from "./free-roam-dual-turret-boat.js";

const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);
const PURCHASE_RANGE = 22;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 220) world.events.splice(0, world.events.length - 220);
}

function inputObjects(world, playerIndex) {
  return [...new Set([
    world?.freeActivities?.inputs?.[playerIndex],
    world?.operationInputs?.[playerIndex],
    world?.inputs?.[playerIndex],
  ].filter(Boolean))];
}

function currentInput(world, playerIndex) {
  return world?.freeActivities?.inputs?.[playerIndex]
    || world?.operationInputs?.[playerIndex]
    || world?.inputs?.[playerIndex]
    || {};
}

function setInputField(world, playerIndex, key, value, saved) {
  for (const input of inputObjects(world, playerIndex)) {
    saved.push([input, key, input[key]]);
    input[key] = value;
  }
}

export function ensureDualTurretPurchaseState(world) {
  world.freeDualTurretPurchase ||= {
    purchased: false,
    price: DUAL_TURRET_PRICE,
    purchasedBy: null,
    purchasedAt: 0,
    previousAction: Array.from({length: world.players?.length || 2}, () => false),
    lastDeniedAt: Array.from({length: world.players?.length || 2}, () => -999),
  };
  const state = world.freeDualTurretPurchase;
  if (typeof state.purchased !== "boolean") state.purchased = false;
  state.price = DUAL_TURRET_PRICE;
  if (!Array.isArray(state.previousAction)) state.previousAction = [];
  if (!Array.isArray(state.lastDeniedAt)) state.lastDeniedAt = [];
  while (state.previousAction.length < (world.players?.length || 2)) state.previousAction.push(false);
  while (state.lastDeniedAt.length < (world.players?.length || 2)) state.lastDeniedAt.push(-999);
  return state;
}

export function prepareDualTurretPurchaseRoom(world) {
  const state = ensureDualTurretPurchaseState(world);
  state.purchased = false;
  state.purchasedBy = null;
  state.purchasedAt = 0;
  state.previousAction.fill(false);
  state.lastDeniedAt.fill(-999);
  return state;
}

export function dualTurretPurchased(world) {
  return Boolean(ensureDualTurretPurchaseState(world).purchased);
}

function playerCanPurchase(world, playerIndex, boat) {
  const player = world.players?.[playerIndex];
  return Boolean(
    player?.combat?.alive
    && ["foot", "swim", "roof"].includes(player.mode)
    && distance(player, boat) <= PURCHASE_RANGE
  );
}

export function prepareDualTurretPurchaseStep(world) {
  const state = ensureDualTurretPurchaseState(world);
  const boat = dualTurretBoat(world);
  const saved = [];
  const originals = (world.players || []).map((_, index) => ({...currentInput(world, index)}));
  if (!boat || state.purchased || boat.sunk) return {state, saved, originals};

  for (let playerIndex = 0; playerIndex < originals.length; playerIndex += 1) {
    const input = originals[playerIndex];
    const rising = Boolean(input.action && !state.previousAction[playerIndex]);
    if (!rising || !playerCanPurchase(world, playerIndex, boat)) continue;
    setInputField(world, playerIndex, "action", false, saved);
    const activities = world.freeActivities;
    const credits = Math.max(0, Math.floor(Number(activities?.credits) || 0));
    if (!activities || credits < state.price) {
      const now = Number(world.time) || 0;
      if (now - (Number(state.lastDeniedAt[playerIndex]) || -999) >= 1.2) {
        state.lastDeniedAt[playerIndex] = now;
        emit(world, "dual-turret-purchase-denied", `Двухместный бронекатер стоит ${state.price} кредитов. У команды ${credits}.`, [playerIndex], {
          sourcePlayer: playerIndex,
          boatId: boat.id,
          price: state.price,
          credits,
          x: boat.x,
          y: boat.y,
        });
      }
      continue;
    }
    activities.credits = credits - state.price;
    state.purchased = true;
    state.purchasedBy = playerIndex;
    state.purchasedAt = Number(world.time) || 0;
    emit(world, "dual-turret-purchased", `Куплен двухместный бронекатер за ${state.price} кредитов. Броня 200, корпус 300, две независимые установки. Нажми действие ещё раз, чтобы занять своё место. Баланс команды ${activities.credits}.`, [0, 1], {
      sourcePlayer: playerIndex,
      boatId: boat.id,
      price: state.price,
      credits: activities.credits,
      x: boat.x,
      y: boat.y,
    });
  }
  return {state, saved, originals};
}

export function finishDualTurretPurchaseStep(context) {
  for (let index = context.saved.length - 1; index >= 0; index -= 1) {
    const [input, key, value] = context.saved[index];
    input[key] = value;
  }
  for (let index = 0; index < context.state.previousAction.length; index += 1) {
    context.state.previousAction[index] = Boolean(context.originals[index]?.action);
  }
}
