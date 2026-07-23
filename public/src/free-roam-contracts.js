"use strict";

import {catalogForCategory, cargoDefinition} from "./free-roam-contract-catalog.js";
import {contractBonusMultiplier, waterExposureTick} from "./free-roam-cargo-traits.js";
import {updateSalvageExtraction} from "./free-roam-salvage.js";
import {activatePursuerSquad, activePursuers, isPursuerSquadDefeated} from "./free-roam-pursuer-squad.js?v=32";
import {activeHostileGunners} from "./free-roam-hostile-gunners.js?v=32";

export const CONTRACT_BOARD = Object.freeze({id: "contract-board", kind: "contract-board", label: "доска заказов", x: 194, y: 58});
export const CONTRACT_BOARD_ACTION_RANGE = 8.5;
export const CONTRACT_BOARD_AUDIO_RANGE = 26;
const CATEGORIES = Object.freeze(["normal", "salvage", "dangerous"]);
const CATEGORY_LABELS = Object.freeze({normal: "обычная доставка", salvage: "поиск металлолома", dangerous: "опасная работа"});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function nextRandom(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}

function shuffledIds(state, category, previousTail = []) {
  const ids = catalogForCategory(category).map(item => item.id);
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(nextRandom(state) * (index + 1));
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
  }
  if (previousTail.length) {
    ids.sort((left, right) => Number(previousTail.includes(left)) - Number(previousTail.includes(right)));
  }
  return ids;
}

function ensureDeck(state, category) {
  state.decks ||= {};
  state.history ||= {};
  state.decks[category] ||= [];
  state.history[category] ||= [];
  if (!state.decks[category].length) {
    state.decks[category] = shuffledIds(state, category, state.history[category].slice(-24));
  }
  return state.decks[category];
}

function drawDefinition(state, category) {
  const deck = ensureDeck(state, category);
  const id = deck.shift();
  state.history[category].push(id);
  if (state.history[category].length > 96) state.history[category].splice(0, state.history[category].length - 96);
  return cargoDefinition(id);
}

function offerFromDefinition(definition) {
  return {
    id: `offer-${definition.id}`,
    definitionId: definition.id,
    category: definition.category,
    label: definition.label,
    description: definition.description,
    creditReward: definition.creditReward,
    scrapReward: definition.scrapReward,
    bonus: definition.bonus,
    threat: definition.threat,
    weight: definition.weight,
    slots: definition.slots,
  };
}

function refreshOffers(state) {
  state.offers = CATEGORIES.map(category => offerFromDefinition(drawDefinition(state, category)));
  state.offerGeneration += 1;
}

export function createContractsState(playerCount = 2) {
  const state = {
    seed: 0x9c47e21,
    decks: {},
    history: {},
    offers: [],
    offerGeneration: 0,
    activeContract: null,
    completedContracts: 0,
    abandonedContracts: 0,
    scrap: 0,
    boardOpen: Array.from({length: playerCount}, () => false),
    boardSelection: Array.from({length: playerCount}, () => 0),
    boardPrompted: Array.from({length: playerCount}, () => false),
    encounterActive: false,
    encounterLevel: 0,
    encounterDefeated: false,
  };
  refreshOffers(state);
  return state;
}

export function ensureContracts(world) {
  world.freeContracts ||= createContractsState(world.players?.length || 2);
  const state = world.freeContracts;
  if (!Number.isFinite(state.seed)) state.seed = 0x9c47e21;
  if (!Array.isArray(state.offers) || state.offers.length !== 3) refreshOffers(state);
  if (!Number.isFinite(state.offerGeneration)) state.offerGeneration = 0;
  if (!Number.isFinite(state.completedContracts)) state.completedContracts = 0;
  if (!Number.isFinite(state.abandonedContracts)) state.abandonedContracts = 0;
  if (!Number.isFinite(state.scrap)) state.scrap = 0;
  state.boardOpen ||= Array.from({length: world.players.length}, () => false);
  state.boardSelection ||= Array.from({length: world.players.length}, () => 0);
  state.boardPrompted ||= Array.from({length: world.players.length}, () => false);
  while (state.boardOpen.length < world.players.length) state.boardOpen.push(false);
  while (state.boardSelection.length < world.players.length) state.boardSelection.push(0);
  while (state.boardPrompted.length < world.players.length) state.boardPrompted.push(false);
  state.decks ||= {};
  state.history ||= {};
  for (const category of CATEGORIES) ensureDeck(state, category);
  return state;
}

export function contractsUnlocked(world) {
  return world?.freeScenario?.phase === "victory";
}

export function encounterActive(world) {
  return Boolean(ensureContracts(world).encounterActive);
}

export function contractBoardNavigationTarget() {
  return {...CONTRACT_BOARD};
}

export function isPlayerNearContractBoard(player, maximum = CONTRACT_BOARD_ACTION_RANGE) {
  return Boolean(player?.mode === "foot" && distance(player, CONTRACT_BOARD) <= maximum);
}

function boardEntries(state) {
  if (state.activeContract) {
    return [{id: "active", active: true}, {id: "abandon", abandon: true}];
  }
  return state.offers;
}

function boardIndex(state, playerIndex) {
  const entries = boardEntries(state);
  const raw = Math.floor(Number(state.boardSelection[playerIndex]) || 0);
  const index = ((raw % entries.length) + entries.length) % entries.length;
  state.boardSelection[playerIndex] = index;
  return index;
}

function describeOffer(offer) {
  const threat = Math.max(0, Number(offer.threat) || 0);
  const extras = [];
  if (offer.scrapReward) extras.push(`${offer.scrapReward} единиц металлолома`);
  if (offer.bonus) extras.push(offer.bonus);
  return `${CATEGORY_LABELS[offer.category]}. ${offer.label}. ${offer.description} Вес ${offer.weight}. Награда ${offer.creditReward} кредитов${extras.length ? ` и ${extras.join(", ")}` : ""}. Угроза ${threat} из пяти.`;
}

function describeEntry(state, entry) {
  if (entry?.active) {
    const active = state.activeContract;
    return `Текущий заказ: ${active.label}. Этап: ${active.phase}. Награда ${active.creditReward} кредитов.`;
  }
  if (entry?.abandon) return "Отказаться от текущего заказа. Потребуется повторное подтверждение.";
  return describeOffer(entry);
}

export function handleContractBoardAction(world, playerIndex) {
  const state = ensureContracts(world);
  const player = world.players?.[playerIndex];
  if (!contractsUnlocked(world) || !player?.combat?.alive || !isPlayerNearContractBoard(player)) return false;
  state.boardOpen[playerIndex] = true;
  const entries = boardEntries(state);
  const entry = entries[boardIndex(state, playerIndex)];
  emit(world, "contract-board-open", `Доска заказов открыта. ${describeEntry(state, entry)} Листай и подтверждай.`, [playerIndex], {sourcePlayer: playerIndex, x: CONTRACT_BOARD.x, y: CONTRACT_BOARD.y});
  return true;
}

function spawnPoint(state, category) {
  const index = Math.floor(nextRandom(state) * 6);
  const water = [
    {x: 68, y: 252}, {x: 344, y: 272}, {x: 92, y: 126}, {x: 328, y: 155}, {x: 205, y: 294}, {x: 235, y: 112},
  ];
  const land = [
    {x: 74, y: 42}, {x: 336, y: 38}, {x: 126, y: 58}, {x: 294, y: 57}, {x: 172, y: 24}, {x: 250, y: 28},
  ];
  if (category === "salvage") return water[index];
  return nextRandom(state) < 0.68 ? water[index] : land[index];
}

function createContractCrate(world, active, definition) {
  const activities = world.freeActivities;
  const point = spawnPoint(world.freeContracts, definition.category);
  const crate = {
    id: `crate-contract-${active.id}`,
    kind: "contract",
    label: definition.label,
    rarity: definition.rarity,
    weight: definition.weight,
    slots: definition.slots,
    traits: [...definition.traits],
    x: point.x,
    y: point.y,
    state: "world",
    carriedBy: null,
    stowedBoat: null,
    source: "contract",
    singleUse: true,
    contractId: active.id,
    contractDefinitionId: definition.id,
    contractCategory: definition.category,
    contractDamage: 0,
    waterExposure: 0,
    extractionSeconds: definition.extractionSeconds,
    extractionProgress: 0,
    extracted: definition.category !== "salvage",
  };
  activities.crates.push(crate);
  active.crateId = crate.id;
  active.phase = definition.category === "salvage" ? "locate" : "transport";
  active.objectivePosition = {x: crate.x, y: crate.y};
  emit(world, "contract-cargo-spawn", `Заказ принят. Цель: ${definition.label}. Сонар обновлён.`, [0, 1], {crateId: crate.id, contractId: active.id, x: crate.x, y: crate.y});
  return crate;
}

function acceptOffer(world, playerIndex, offer) {
  const state = ensureContracts(world);
  if (state.activeContract || !offer?.definitionId) return false;
  const definition = cargoDefinition(offer.definitionId);
  if (!definition) return false;
  state.activeContract = {
    id: `contract-${state.offerGeneration}-${definition.id}`,
    definitionId: definition.id,
    category: definition.category,
    label: definition.label,
    description: definition.description,
    creditReward: definition.creditReward,
    scrapReward: definition.scrapReward,
    bonus: definition.bonus,
    threat: definition.threat,
    maximumThreat: definition.threat,
    phase: "accepted",
    acceptedBy: playerIndex,
    acceptedAt: world.time,
    crateId: null,
    rewardIssued: false,
    abandonConfirmUntil: 0,
  };
  state.encounterActive = false;
  state.encounterLevel = 0;
  state.encounterDefeated = false;
  for (let index = 0; index < state.boardOpen.length; index += 1) state.boardOpen[index] = false;
  createContractCrate(world, state.activeContract, definition);
  return true;
}

function removeContractCrate(world, active) {
  const crate = world.freeActivities?.crates?.find(candidate => candidate.id === active?.crateId);
  if (!crate) return;
  for (const boat of world.boats || []) boat.cargo = (boat.cargo || []).filter(id => id !== crate.id);
  for (const player of world.players || []) if (player.combat?.carriedCrate === crate.id) player.combat.carriedCrate = null;
  crate.state = "consumed";
}

function abandonContract(world, playerIndex) {
  const state = ensureContracts(world);
  const active = state.activeContract;
  if (!active) return false;
  if ((Number(active.abandonConfirmUntil) || 0) < world.time) {
    active.abandonConfirmUntil = world.time + 5;
    emit(world, "contract-abandon-warning", "Нажми подтверждение ещё раз в течение пяти секунд, чтобы отказаться от заказа без награды.", [playerIndex]);
    return true;
  }
  removeContractCrate(world, active);
  state.activeContract = null;
  state.encounterActive = false;
  state.encounterLevel = 0;
  state.abandonedContracts += 1;
  refreshOffers(state);
  for (let index = 0; index < state.boardOpen.length; index += 1) state.boardOpen[index] = false;
  emit(world, "contract-abandoned", "Командный заказ отменён. Новые предложения появились на доске.", [0, 1]);
  return true;
}

function applyBonus(world, bonus, playerIndex, boat) {
  const combat = world.players?.[playerIndex]?.combat;
  if (!bonus) return "";
  if (bonus.includes("автомата") && combat) combat.ammo = Math.min(240, (Number(combat.ammo) || 0) + 30);
  else if (bonus.includes("пистолета") && combat) combat.pistolAmmo = Math.min(180, (Number(combat.pistolAmmo) || 0) + 24);
  else if (bonus.includes("пластина") && boat) boat.repairPatches = Math.min(10, (Number(boat.repairPatches) || 0) + 1);
  else if (bonus.includes("канистра") && boat) boat.refuelCanisters = Math.min(5, (Number(boat.refuelCanisters) || 0) + 1);
  return bonus;
}

export function completeContractDelivery(world, playerIndex, boat, crate) {
  const state = ensureContracts(world);
  const active = state.activeContract;
  if (!active || active.rewardIssued || crate?.contractId !== active.id) return null;
  const definition = cargoDefinition(active.definitionId);
  if (!definition) return null;
  active.rewardIssued = true;
  const multiplier = contractBonusMultiplier(crate);
  const credits = Math.max(1, Math.round(definition.creditReward * multiplier));
  world.freeActivities.credits = (Number(world.freeActivities.credits) || 0) + credits;
  state.scrap += definition.scrapReward;
  const bonus = applyBonus(world, definition.bonus, playerIndex, boat);
  state.completedContracts += 1;
  active.phase = "completed";
  active.completedAt = world.time;
  const damageText = multiplier < 0.99 ? ` Груз повреждён, выплата уменьшена.` : "";
  const rewardText = `${credits} кредитов${definition.scrapReward ? `, металлолом ${definition.scrapReward}` : ""}${bonus ? `, бонус: ${bonus}` : ""}`;
  emit(world, "contract-completed", `Заказ выполнен: ${definition.label}. Получено ${rewardText}. Баланс команды ${world.freeActivities.credits}.${damageText}`, [0, 1], {contractId: active.id, crateId: crate.id, credits, scrap: definition.scrapReward, sourcePlayer: playerIndex, x: boat?.x ?? crate.x, y: boat?.y ?? crate.y});
  state.activeContract = null;
  state.encounterActive = false;
  state.encounterLevel = 0;
  refreshOffers(state);
  return {credits, scrap: definition.scrapReward, bonus, text: `Контрактная награда: ${rewardText}.${damageText}`};
}

function activateContractPursuit(world, active) {
  const pursuer = world.freeActivities?.marauder;
  if (!pursuer || stateAlreadyFighting(world)) return;
  const carrier = world.players.find(player => player?.combat?.carriedCrate === active.crateId)
    || world.players.find(player => {
      const boat = Number.isInteger(player?.activeBoat) ? world.boats[player.activeBoat] : null;
      return boat?.cargo?.includes(active.crateId);
    }) || world.players[0];
  pursuer.x = clamp((carrier?.x || 210) + 105, 18, 402);
  pursuer.y = clamp((carrier?.y || 180) + 70, 92, 302);
  pursuer.heading = 315;
  pursuer.speed = 0;
  pursuer.hull = 72;
  pursuer.active = true;
  pursuer.destroyed = false;
  pursuer.ramCooldown = 4;
  pursuer.recoveryRemaining = 0;
  pursuer.respawnAt = 0;
  activatePursuerSquad(world);
  const state = ensureContracts(world);
  state.encounterActive = true;
  state.encounterLevel = 2;
  active.phase = "combat";
  emit(world, "contract-threat-start", "Опасный груз обнаружен. Угроза два из пяти: в бухту вошли катера-преследователи. Во время боя доступны только боевые цели.", [0, 1], {contractId: active.id, threat: 2, x: pursuer.x, y: pursuer.y});
}

function stateAlreadyFighting(world) {
  return activePursuers(world).length > 0 || activeHostileGunners(world).length > 0;
}

export function notifyContractCargoStowed(world, crate) {
  const state = ensureContracts(world);
  const active = state.activeContract;
  if (!active || crate?.contractId !== active.id) return;
  active.phase = "transport";
  if (active.category === "dangerous" && !state.encounterActive) activateContractPursuit(world, active);
}

function rising(input, previous, key) {
  return Boolean(input?.[key] && !previous?.[key]);
}

function closeBoard(world, playerIndex, text = "Доска заказов закрыта.") {
  const state = ensureContracts(world);
  if (!state.boardOpen[playerIndex]) return false;
  state.boardOpen[playerIndex] = false;
  emit(world, "contract-board-closed", text, [playerIndex], {sourcePlayer: playerIndex, x: CONTRACT_BOARD.x, y: CONTRACT_BOARD.y});
  return true;
}

export function updateContractBoard(world) {
  const state = ensureContracts(world);
  const unlocked = contractsUnlocked(world);
  const inputs = world.freeActivities?.inputs || [];
  const previous = world.freeActivities?.previousInputs || [];
  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const near = Boolean(unlocked && world.freeActivities.presence?.[index] && player?.combat?.alive && isPlayerNearContractBoard(player));
    if (near && !state.boardPrompted[index]) {
      state.boardPrompted[index] = true;
      emit(world, "contract-board-ready", "Доска заказов рядом. Действие — открыть.", [index], {sourcePlayer: index, x: CONTRACT_BOARD.x, y: CONTRACT_BOARD.y});
    } else if (!near && distance(player, CONTRACT_BOARD) > CONTRACT_BOARD_ACTION_RANGE + 3) state.boardPrompted[index] = false;
    if (!state.boardOpen[index]) continue;
    if (!near) {
      closeBoard(world, index, "Ты отошёл от доски. Доска заказов закрыта.");
      continue;
    }
    const entries = boardEntries(state);
    if (rising(inputs[index], previous[index], "boardClose")) {
      closeBoard(world, index);
      continue;
    }
    if (rising(inputs[index], previous[index], "boardPrevious") || rising(inputs[index], previous[index], "boardNext")) {
      const direction = rising(inputs[index], previous[index], "boardPrevious") ? -1 : 1;
      state.boardSelection[index] += direction;
      const entry = entries[boardIndex(state, index)];
      emit(world, "contract-board-selection", describeEntry(state, entry), [index], {sourcePlayer: index, x: CONTRACT_BOARD.x, y: CONTRACT_BOARD.y});
    }
    if (rising(inputs[index], previous[index], "boardAccept")) {
      const entry = entries[boardIndex(state, index)];
      if (entry?.abandon) abandonContract(world, index);
      else if (entry?.active) emit(world, "contract-board-selection", describeEntry(state, entry), [index]);
      else acceptOffer(world, index, entry);
    }
  }
}

export function suppressGameplayWhileContractBoard(world) {
  const state = ensureContracts(world);
  const blocked = ["up", "down", "left", "right", "run", "pump", "repair", "action", "jump", "attack", "weapon", "sonar", "guide"];
  for (let index = 0; index < world.players.length; index += 1) {
    if (!state.boardOpen[index]) continue;
    for (const source of [world.inputs?.[index], world.operationInputs?.[index], world.freeActivities?.inputs?.[index]]) {
      if (!source) continue;
      for (const key of blocked) source[key] = false;
    }
  }
}

export function updateContracts(world, dt) {
  const state = ensureContracts(world);
  updateContractBoard(world);
  suppressGameplayWhileContractBoard(world);
  updateSalvageExtraction(world, dt, emit);
  const active = state.activeContract;
  if (active?.crateId) {
    const crate = world.freeActivities?.crates?.find(candidate => candidate.id === active.crateId);
    if (crate) waterExposureTick(crate, dt);
  }
  if (state.encounterActive && isPursuerSquadDefeated(world) && activeHostileGunners(world).length === 0) {
    state.encounterActive = false;
    state.encounterDefeated = true;
    if (active) active.phase = "return";
    emit(world, "contract-threat-cleared", "Боевая угроза устранена. Навигация к заказу восстановлена. Добыча и контрактный груз остаются в мире.", [0, 1]);
  }
}

export function contractNavigationTarget(world, playerIndex) {
  const state = ensureContracts(world);
  const active = state.activeContract;
  if (!active) return contractsUnlocked(world) ? contractBoardNavigationTarget() : null;
  const crate = world.freeActivities?.crates?.find(candidate => candidate.id === active.crateId);
  if (crate && ["world", "carried", "stowed"].includes(crate.state)) {
    const player = world.players[playerIndex];
    const ownedBoat = world.boats.find(boat => boat.owner === playerIndex);
    const carrying = player?.combat?.carriedCrate === crate.id || ownedBoat?.cargo?.includes(crate.id);
    if (carrying || crate.state === "stowed" || crate.state === "carried") {
      return {id: "contract-dock", kind: "dock", label: "причал для сдачи заказа", x: 210, y: player?.mode === "boat" ? 82 : 65};
    }
    return {id: crate.id, kind: "contract-cargo", label: crate.label || active.label, x: crate.x, y: crate.y};
  }
  return contractBoardNavigationTarget();
}

export function contractStatus(world) {
  const state = ensureContracts(world);
  const active = state.activeContract;
  if (!contractsUnlocked(world)) return "Доска заказов откроется после первой победы над преследователями.";
  if (!active) return `Доска заказов доступна. Металлолом команды: ${state.scrap}. Выполнено заказов: ${state.completedContracts}.`;
  return `Активный заказ: ${active.label}. Этап ${active.phase}. Угроза ${state.encounterActive ? state.encounterLevel : active.threat} из пяти. Награда ${active.creditReward} кредитов. Металлолом команды: ${state.scrap}.`;
}
