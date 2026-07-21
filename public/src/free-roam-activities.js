"use strict";

import {placeJoiningPlayer} from "./free-roam-player-spawn.js";
import {deliverCarriedCargoAtDock, updateCargoActionPrompts} from "./free-roam-cargo-actions.js?v=38";
import {
  CARGO_ACTION_RANGE,
  LANDING_MAX_X,
  LANDING_MIN_X,
  isBoatDockZone,
} from "./free-roam-cargo-rules.js?v=32";
import {updateFootDockDelivery} from "./free-roam-foot-dock.js?v=38";
import {grantWeaponFromCrate} from "./free-roam-weapon-crates.js?v=32";

const WORLD_CRATES = Object.freeze([
  {id: "crate-plates", kind: "plates", rarity: "common", weight: 2, x: 180, y: 34},
  {id: "crate-fuel", kind: "fuel", rarity: "common", weight: 3, x: 254, y: 45},
  {id: "crate-pump", kind: "pump", rarity: "uncommon", weight: 3, x: 205, y: 112},
  {id: "crate-value", kind: "valuable", rarity: "uncommon", weight: 4, x: 82, y: 218},
  {id: "crate-knife", kind: "knife", rarity: "rare", weight: 1, x: 338, y: 244},
  {id: "crate-automatic", kind: "automatic", rarity: "rare", weight: 4, x: 116, y: 286, singleUse: true},
  {id: "crate-ammo", kind: "ammo", rarity: "uncommon", weight: 2, x: 316, y: 146},
]);

const LABELS = Object.freeze({
  plates: "ремонтные пластины",
  fuel: "топливо",
  pump: "усилитель насоса",
  valuable: "ценный груз",
  knife: "нож",
  automatic: "автомат",
  ammo: "патроны",
});

const STATUS_DETAILS = Object.freeze({
  pump: "После доставки он ускорит откачку воды на этой лодке.",
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const pumpRateText = value => {
  const rate = Number(value) || 0;
  const formatted = rate.toFixed(1).replace(/\.0$/, "").replace(".", ",");
  return `${formatted} ${Number.isInteger(rate) ? "процентов" : "процента"}`;
};

function copyCrate(crate) {
  return {
    ...crate,
    state: "world",
    carriedBy: null,
    stowedBoat: null,
    respawnAt: 0,
    source: crate.source || "world",
  };
}

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function createActivitiesState(playerCount = 2) {
  return {
    presence: Array.from({length: playerCount}, (_, index) => index === 0),
    score: Array.from({length: playerCount}, () => 0),
    delivered: Array.from({length: playerCount}, () => 0),
    crates: WORLD_CRATES.map(copyCrate),
    nextCrateId: WORLD_CRATES.length + 1,
    dockProgress: [0, 0],
    inputs: Array.from({length: playerCount}, () => ({})),
    previousInputs: Array.from({length: playerCount}, () => ({})),
    seed: 0x4a61c3,
    marauder: null,
  };
}

export function ensureActivities(world) {
  if (!world.freeActivities) world.freeActivities = createActivitiesState(world.players?.length || 2);
  const state = world.freeActivities;
  state.presence ||= [true, false];
  state.score ||= [0, 0];
  state.delivered ||= [0, 0];
  state.crates ||= WORLD_CRATES.map(copyCrate);
  state.dockProgress ||= [0, 0];
  state.inputs ||= [{}, {}];
  state.previousInputs ||= [{}, {}];
  state.seed ||= 0x4a61c3;
  while (state.presence.length < world.players.length) state.presence.push(false);
  while (state.score.length < world.players.length) state.score.push(0);
  while (state.delivered.length < world.players.length) state.delivered.push(0);
  while (state.inputs.length < world.players.length) state.inputs.push({});
  while (state.previousInputs.length < world.players.length) state.previousInputs.push({});
  for (const boat of world.boats || []) {
    boat.cargo ||= [];
    if (!Number.isFinite(boat.cargoWeight)) boat.cargoWeight = 0;
    if (!Number.isFinite(boat.cargoPumpBonus)) boat.cargoPumpBonus = 0;
  }
  return state;
}

function nextRandom(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}

function randomSpawn(state, crate) {
  const onLand = nextRandom(state) < 0.38;
  crate.x = onLand
    ? LANDING_MIN_X + nextRandom(state) * (LANDING_MAX_X - LANDING_MIN_X)
    : 34 + nextRandom(state) * 352;
  crate.y = onLand ? 16 + nextRandom(state) * 48 : 96 + nextRandom(state) * 190;
}

export function setPresence(world, playerIndex, present) {
  const state = ensureActivities(world);
  if (state.presence[playerIndex] == null) return;
  const wasPresent = state.presence[playerIndex];
  state.presence[playerIndex] = Boolean(present);
  if (!wasPresent && state.presence[playerIndex]) placeJoiningPlayer(world, playerIndex);
}

export function storeActivityInput(world, playerIndex, input) {
  const state = ensureActivities(world);
  if (!state.inputs[playerIndex]) return;
  state.inputs[playerIndex] = {
    attack: Boolean(input?.attack),
    weapon: Boolean(input?.weapon),
    action: Boolean(input?.action),
    sonar: Boolean(input?.sonar),
    guide: Boolean(input?.guide),
    targetId: typeof input?.targetId === "string" ? input.targetId : null,
  };
}

function nearestAvailableCrate(state, point, maximum = Infinity) {
  let found = null;
  let best = maximum;
  for (const crate of state.crates) {
    if (crate.state !== "world") continue;
    const metres = distance(crate, point);
    if (metres <= best + 0.001) {
      found = crate;
      best = metres;
    }
  }
  return {crate: found, distance: best};
}

function nearestUsableBoat(world, point, maximum = Infinity) {
  let found = null;
  let best = maximum;
  for (const boat of world.boats || []) {
    if (boat.sunk) continue;
    const metres = distance(boat, point);
    if (metres < best) {
      found = boat;
      best = metres;
    }
  }
  return {boat: found, distance: best};
}

function stealStowedCargo(world, playerIndex) {
  const state = world.freeActivities;
  const player = world.players[playerIndex];
  if (!["foot", "swim"].includes(player?.mode) || player.combat?.carriedCrate) return false;
  let targetBoat = null;
  let best = 8.5;
  for (const boat of world.boats || []) {
    if (boat.sunk || boat.owner === playerIndex || boat.driver === playerIndex || !(boat.cargo || []).length) continue;
    const metres = distance(player, boat);
    if (metres >= best) continue;
    best = metres;
    targetBoat = boat;
  }
  if (!targetBoat) return false;
  const id = targetBoat.cargo.shift();
  const crate = state.crates.find(candidate => candidate.id === id);
  if (!crate) return false;
  crate.state = "carried";
  crate.carriedBy = playerIndex;
  crate.stowedBoat = null;
  crate.x = player.x;
  crate.y = player.y;
  player.combat.carriedCrate = crate.id;
  const victim = targetBoat.driver ?? targetBoat.owner;
  emit(world, "cargo-stolen", `Ты украл с чужой лодки: ${LABELS[crate.kind] || "груз"}.`, [playerIndex], {
    sourcePlayer: playerIndex,
    victimPlayer: victim,
    crateId: crate.id,
    kind: crate.kind,
    x: player.x,
    y: player.y,
  });
  if (victim !== playerIndex) {
    emit(world, "cargo-stolen", "С твоей лодки украли груз.", [victim], {
      sourcePlayer: playerIndex,
      victimPlayer: victim,
      crateId: crate.id,
      kind: crate.kind,
      x: player.x,
      y: player.y,
    });
  }
  return true;
}

function stow(world, crate, boat, playerIndex) {
  if (!crate || !boat || boat.cargo.length >= 5) return false;
  crate.state = "stowed";
  crate.carriedBy = null;
  crate.stowedBoat = boat.id;
  boat.cargo.push(crate.id);
  const player = world.players[playerIndex];
  if (player?.combat) player.combat.carriedCrate = null;
  grantWeaponFromCrate(world, crate, playerIndex, emit);
  emit(world, "cargo-stowed", `Ящик погружён на лодку: ${LABELS[crate.kind] || "груз"}.`, [playerIndex], {
    sourcePlayer: playerIndex,
    crateId: crate.id,
    kind: crate.kind,
    x: boat.x,
    y: boat.y,
  });
  return true;
}

export function dropCarriedCrate(world, playerIndex, reason = "Груз выпал.") {
  const state = ensureActivities(world);
  const player = world.players[playerIndex];
  const id = player?.combat?.carriedCrate;
  if (!id) return null;
  const crate = state.crates.find(candidate => candidate.id === id);
  player.combat.carriedCrate = null;
  if (!crate) return null;
  crate.state = "world";
  crate.carriedBy = null;
  crate.stowedBoat = null;
  crate.x = Number(player.x) || 210;
  crate.y = Number(player.y) || 62;
  emit(world, "cargo-drop", reason, [0, 1], {
    sourcePlayer: playerIndex,
    crateId: crate.id,
    kind: crate.kind,
    x: crate.x,
    y: crate.y,
  });
  return crate;
}

export function handleActivityAction(world, playerIndex) {
  const state = ensureActivities(world);
  const player = world.players[playerIndex];
  if (!player?.combat?.alive) return true;
  if (player.combat.knockedDown) {
    emit(world, "action-denied", "Ты оглушён и не можешь действовать, пока не поднимешься.", [playerIndex], {
      sourcePlayer: playerIndex,
      x: player.x,
      y: player.y,
    });
    return true;
  }

  const carriedId = player.combat.carriedCrate;
  if (carriedId) {
    const crate = state.crates.find(candidate => candidate.id === carriedId);
    if (deliverCarriedCargoAtDock(world, playerIndex, crate, rewardPlayer, emit)) return true;
    const otherIndex = 1 - playerIndex;
    const other = world.players[otherIndex];
    if (crate && state.presence[otherIndex] && other?.combat?.alive && !other.combat.carriedCrate && distance(player, other) <= 4.5) {
      crate.carriedBy = otherIndex;
      player.combat.carriedCrate = null;
      other.combat.carriedCrate = crate.id;
      emit(world, "cargo-transfer", "Груз передан второму игроку.", [playerIndex, otherIndex], {
        sourcePlayer: playerIndex,
        crateId: crate.id,
        kind: crate.kind,
        x: player.x,
        y: player.y,
      });
      return true;
    }
    const nearest = nearestUsableBoat(world, player, 11);
    if (crate && nearest.boat && stow(world, crate, nearest.boat, playerIndex)) return true;
    dropCarriedCrate(world, playerIndex, "Ты положил груз рядом.");
    return true;
  }

  if (stealStowedCargo(world, playerIndex)) return true;

  const nearest = nearestAvailableCrate(state, player, CARGO_ACTION_RANGE);
  if (!nearest.crate) return false;
  if (player.mode === "boat") {
    const boat = world.boats[player.activeBoat];
    return stow(world, nearest.crate, boat, playerIndex);
  }
  nearest.crate.state = "carried";
  nearest.crate.carriedBy = playerIndex;
  nearest.crate.stowedBoat = null;
  player.combat.carriedCrate = nearest.crate.id;
  grantWeaponFromCrate(world, nearest.crate, playerIndex, emit);
  emit(world, "cargo-pickup", `Ты поднял: ${LABELS[nearest.crate.kind] || "груз"}.`, [playerIndex], {
    sourcePlayer: playerIndex,
    crateId: nearest.crate.id,
    kind: nearest.crate.kind,
    rarity: nearest.crate.rarity,
    x: player.x,
    y: player.y,
  });
  return true;
}

function rewardPlayer(world, playerIndex, boat, crate) {
  const state = world.freeActivities;
  const combat = world.players[playerIndex]?.combat;
  let effect = "Ценный груз принят.";
  switch (crate.kind) {
    case "plates":
      boat.repairPatches += 2;
      effect = "Получено две ремонтные пластины.";
      break;
    case "fuel":
      boat.fuel = clamp(boat.fuel + 35, 0, 100);
      effect = `Топливо пополнено до ${Math.round(boat.fuel)} процентов.`;
      break;
    case "pump":
      boat.cargoPumpBonus = clamp(boat.cargoPumpBonus + 2.5, 0, 7.5);
      effect = `Усилитель установлен. Насос этой лодки откачивает на ${pumpRateText(boat.cargoPumpBonus)} воды в секунду быстрее.`;
      break;
    case "knife":
      if (combat) {
        combat.weapons.knife = true;
        combat.equipped = "knife";
      }
      effect = "Нож добавлен в оружие.";
      break;
    case "automatic":
      grantWeaponFromCrate(world, crate, playerIndex);
      effect = "Ящик с автоматом принят.";
      break;
    case "ammo":
      if (combat) combat.ammo += 30;
      effect = "Получено 30 патронов.";
      break;
    default:
      break;
  }
  const points = crate.rarity === "rare" ? 5 : crate.rarity === "uncommon" ? 3 : 2;
  state.score[playerIndex] += points;
  state.delivered[playerIndex] += 1;
  return effect;
}

function deliverBoatCargo(world, boat) {
  const state = world.freeActivities;
  const playerIndex = state.presence[boat.driver] ? boat.driver : boat.owner;
  const delivered = [];
  const effects = [];
  for (const id of boat.cargo.splice(0)) {
    const crate = state.crates.find(candidate => candidate.id === id);
    if (!crate) continue;
    effects.push(rewardPlayer(world, playerIndex, boat, crate));
    crate.state = crate.singleUse ? "consumed" : "delivered";
    crate.carriedBy = null;
    crate.stowedBoat = null;
    crate.respawnAt = world.time + 12;
    delivered.push(crate);
  }
  if (!delivered.length) return;
  emit(world, "cargo-delivered", `Груз доставлен: ${delivered.length}. ${effects.join(" ")} Очки за доставку: ${state.score[playerIndex]}.`, [0, 1], {
    sourcePlayer: playerIndex,
    count: delivered.length,
    score: state.score[playerIndex],
    kinds: delivered.map(crate => crate.kind),
    x: boat.x,
    y: boat.y,
  });
}

function updateDockDelivery(world, boat, dt) {
  const state = world.freeActivities;
  const atDock = isBoatDockZone(boat);
  if (!atDock || !boat.cargo.length) {
    state.dockProgress[boat.id] = 0;
    return;
  }
  state.dockProgress[boat.id] += dt;
  if (state.dockProgress[boat.id] < 0.45) return;
  state.dockProgress[boat.id] = 0;
  deliverBoatCargo(world, boat);
}

function updateCrates(world) {
  const state = world.freeActivities;
  for (const crate of state.crates) {
    if (crate.state === "carried") {
      const carrier = world.players[crate.carriedBy];
      if (carrier) {
        crate.x = carrier.x;
        crate.y = carrier.y;
      }
    } else if (crate.state === "stowed") {
      const boat = world.boats[crate.stowedBoat];
      if (boat) {
        crate.x = boat.x;
        crate.y = boat.y;
      }
    } else if (crate.state === "delivered" && crate.respawnAt <= world.time) {
      crate.state = "world";
      crate.respawnAt = 0;
      randomSpawn(state, crate);
      emit(world, "cargo-spawn", `Новый груз: ${LABELS[crate.kind] || "ящик"}.`, state.presence.map((present, index) => present ? index : -1).filter(index => index >= 0), {
        crateId: crate.id,
        kind: crate.kind,
        rarity: crate.rarity,
        x: crate.x,
        y: crate.y,
      });
    }
  }
}

function updateBoatLoad(world, boat, dt) {
  const state = world.freeActivities;
  boat.cargoWeight = boat.cargo.reduce((sum, id) => {
    const crate = state.crates.find(candidate => candidate.id === id);
    return sum + (Number(crate?.weight) || 0);
  }, 0);
  const speedLimit = 21 / (1 + boat.cargoWeight * 0.035);
  boat.speed = clamp(boat.speed, -speedLimit * 0.42, speedLimit);
  if (boat.pumpActive && boat.cargoPumpBonus > 0) {
    boat.water = clamp(boat.water - boat.cargoPumpBonus * dt, 0, 100);
  }
  updateDockDelivery(world, boat, dt);
}

export function updateActivities(world, dt) {
  ensureActivities(world);
  updateCrates(world);
  for (const boat of world.boats || []) updateBoatLoad(world, boat, dt);
  updateFootDockDelivery(world, dt, rewardPlayer, emit);
  updateCargoActionPrompts(world, emit);
}

export function finishActivityFrame(world) {
  const state = ensureActivities(world);
  state.previousInputs = state.inputs.map(input => ({...input}));
}

export function spawnRareCrate(world, x, y, kind = "automatic", source = "marauder") {
  const state = ensureActivities(world);
  const crate = copyCrate({
    id: `crate-${source}-${state.nextCrateId++}`,
    kind,
    rarity: "rare",
    weight: kind === "automatic" ? 4 : 2,
    x,
    y,
    source,
    singleUse: source === "pursuer",
  });
  state.crates.push(crate);
  emit(world, "cargo-spawn", `Появился редкий ящик: ${LABELS[kind] || "ценный груз"}.`, [0, 1], {
    crateId: crate.id,
    kind,
    rarity: "rare",
    x,
    y,
  });
  return crate;
}

export function activityStatus(world, playerIndex) {
  const state = ensureActivities(world);
  const player = world.players[playerIndex];
  const carried = state.crates.find(crate => crate.id === player?.combat?.carriedCrate);
  const nearest = nearestAvailableCrate(state, player);
  const boat = Number.isInteger(player?.activeBoat)
    ? world.boats[player.activeBoat]
    : world.boats.find(candidate => candidate.owner === playerIndex);
  const parts = [];
  if (carried) parts.push(`В руках ${LABELS[carried.kind] || "груз"}.`);
  if (nearest.crate) {
    const detail = STATUS_DETAILS[nearest.crate.kind];
    parts.push(`Ближайший груз в ${Math.round(nearest.distance)} метрах: ${LABELS[nearest.crate.kind] || "ящик"}.${detail ? ` ${detail}` : ""}`);
  }
  if ((Number(boat?.cargoPumpBonus) || 0) > 0) {
    parts.push(`Усиление насоса: плюс ${pumpRateText(boat.cargoPumpBonus)} откачки в секунду.`);
  }
  parts.push(`Очки за доставку: ${state.score[playerIndex] || 0}.`);
  if (!state.presence[1 - playerIndex]) parts.push("Пока ждём второго игрока.");
  return parts.join(" ");
}
