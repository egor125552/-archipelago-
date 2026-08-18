"use strict";

import "./free-roam-keyboard-release-watchdog-v1.js?v=1";
import {describeCombatTarget, listCombatTargets} from "./free-roam-targeting.js?v=35";
import {combatMenuActive} from "./free-roam-combat-context.js?v=1";
import {listVesselNavigationTargets} from "./vessel/vessel-navigation.js?v=1";
import {spatialLocationIdFromNavigationTargetId, spatialLocationMenuTargets} from "./spatial/spatial-location-catalog.js";

const NAVIGATION_ENTRIES = Object.freeze([
  Object.freeze({id: "navigation-objective", menuKind: "navigation", navigationTargetId: "objective", label: "текущая задача"}),
  Object.freeze({id: "navigation-merchant", menuKind: "navigation", navigationTargetId: "merchant", label: "торговый причал"}),
  Object.freeze({id: "navigation-board", menuKind: "navigation", navigationTargetId: "board", label: "доска заказов"}),
  Object.freeze({id: "navigation-locations", menuKind: "submenu", submenu: "locations", label: "локации"}),
]);

function normalizeVoiceText(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е");
}

function targetMenuVoice(synth) {
  const voices = [...(synth?.getVoices?.() || [])];
  return voices
    .filter(voice => normalizeVoiceText(voice?.lang).startsWith("ru"))
    .sort((left, right) => {
      const score = voice => {
        const name = normalizeVoiceText(`${voice?.name || ""} ${voice?.voiceURI || ""}`);
        let value = 10;
        if (/milena|милена/.test(name)) value += 1000;
        if (/enhanced|premium|improved|natural|neural|улучш/.test(name)) value += 500;
        if (/compact|компакт/.test(name)) value -= 200;
        return value;
      };
      return score(right) - score(left);
    })[0] || null;
}

function targetMenuSpeechRate() {
  try {
    const value = Number(globalThis.localStorage?.getItem?.("echo-free-roam-speech-rate"));
    if (Number.isFinite(value) && value > 0) return Math.max(0.6, Math.min(2, value));
  } catch (_) {}
  return 1.18;
}

function targetMenuSpeechEnabled() {
  try { return globalThis.localStorage?.getItem?.("echo-free-roam-speech") !== "off"; }
  catch (_) { return true; }
}

export function createTargetMenuSpeechQueue({
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  resetDelayMs = 90,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
} = {}) {
  const available = Boolean(synth && Utterance && typeof synth.speak === "function");
  let generation = 0;
  let queue = [];
  let activeUtterance = null;
  let startTimer = 0;
  let watchdogTimer = 0;

  function clearTimers() {
    if (startTimer) clearTimer(startTimer);
    if (watchdogTimer) clearTimer(watchdogTimer);
    startTimer = 0;
    watchdogTimer = 0;
  }

  function buildUtterance(text) {
    const utterance = new Utterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = targetMenuSpeechRate();
    utterance.pitch = 1;
    const voice = targetMenuVoice(synth);
    if (voice) utterance.voice = voice;
    return utterance;
  }

  function startNext(delay = 0) {
    if (!available || activeUtterance || startTimer || !queue.length) return false;
    const expectedGeneration = generation;
    const run = () => {
      startTimer = 0;
      if (expectedGeneration !== generation || activeUtterance || !queue.length) return;
      const text = queue.shift();
      const utterance = buildUtterance(text);
      activeUtterance = utterance;
      const finish = () => {
        if (expectedGeneration !== generation || activeUtterance !== utterance) return;
        if (watchdogTimer) clearTimer(watchdogTimer);
        watchdogTimer = 0;
        activeUtterance = null;
        startNext(0);
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      try {
        synth.resume?.();
        synth.speak(utterance);
        watchdogTimer = setTimer(finish, Math.max(5_000, Math.min(20_000, text.length * 115)));
      } catch (_) {
        finish();
      }
    };
    if (delay > 0) startTimer = setTimer(run, delay);
    else run();
    return true;
  }

  function enqueue(text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!available || !targetMenuSpeechEnabled() || !normalized) return false;
    queue.push(normalized);
    startNext(0);
    return true;
  }

  function resetAndSpeak(text) {
    if (!available || !targetMenuSpeechEnabled()) return false;
    generation += 1;
    clearTimers();
    queue = [];
    activeUtterance = null;
    try { synth.cancel?.(); } catch (_) {}
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return true;
    queue.push(normalized);
    // Safari may discard speech started in the same task as cancel(). One
    // short reset window is enough; later target steps are a true FIFO queue.
    startNext(Math.max(32, Number(resetDelayMs) || 90));
    return true;
  }

  function clear({cancel = true} = {}) {
    generation += 1;
    clearTimers();
    queue = [];
    activeUtterance = null;
    if (cancel) {
      try { synth?.cancel?.(); } catch (_) {}
    }
  }

  return {
    available,
    enqueue,
    resetAndSpeak,
    clear,
    snapshot: () => ({queued: queue.length, active: Boolean(activeUtterance), delayed: Boolean(startTimer)}),
  };
}

export function createTargetMenu({
  getWorld,
  getPlayerIndex,
  getTargetId,
  setTargetId,
  getNavigationTargetId = () => "objective",
  setNavigationTargetId = () => {},
  releaseMovement,
  sendInput,
  announce,
  render,
}) {
  let open = false;
  let menuLevel = "root";
  let cursor = 0;
  let targets = [];
  const targetSpeech = createTargetMenuSpeechQueue();

  function rootTargets() {
    const world = getWorld();
    const playerIndex = getPlayerIndex();
    const combat = world?.players?.[playerIndex]?.combat;
    const fighting = combatMenuActive(world);
    const rangedReady = Boolean(
      (combat?.weapons?.pistol && combat.pistolAmmo > 0)
      || (combat?.weapons?.automatic && combat.ammo > 0)
    );
    const combatTargets = (fighting || rangedReady)
      ? listCombatTargets(world, playerIndex, 420)
        .filter(target => !fighting || !["player", "boat"].includes(target.kind))
        .map(target => ({...target, menuKind: "combat"}))
      : [];
    if (fighting) return combatTargets;
    const vesselTargets = listVesselNavigationTargets(world, playerIndex).map(target => ({
      ...target,
      id: `navigation-${target.id}`,
      menuKind: "navigation",
      navigationTargetId: target.id,
    }));
    return [...NAVIGATION_ENTRIES.map(entry => ({...entry})), ...vesselTargets, ...combatTargets];
  }

  function locationTargets() {
    return spatialLocationMenuTargets(getWorld()?.spatialLocationCatalog || []).map(entry => ({...entry}));
  }

  function availableTargets() {
    return menuLevel === "locations" ? locationTargets() : rootTargets();
  }

  function refresh() {
    const selectedId = targets[cursor]?.id || null;
    targets = availableTargets();
    if (!targets.length) {
      cursor = 0;
      return null;
    }
    const refreshedIndex = selectedId ? targets.findIndex(target => target.id === selectedId) : -1;
    cursor = refreshedIndex >= 0
      ? refreshedIndex
      : ((cursor % targets.length) + targets.length) % targets.length;
    return targets[cursor];
  }

  function describe(target) {
    if (!target) return menuLevel === "locations" ? "Локаций пока нет." : "Доступных целей больше нет.";
    if (menuLevel === "locations") {
      return `Локации ${cursor + 1} из ${targets.length}: ${target.label}.`;
    }
    if (target.menuKind === "navigation" || target.menuKind === "submenu") {
      return `Навигация ${cursor + 1} из ${targets.length}: ${target.label}.`;
    }
    const combatTargets = targets.filter(candidate => candidate.menuKind === "combat");
    const combatIndex = Math.max(0, combatTargets.findIndex(candidate => candidate.id === target.id));
    return `Боевая цель. ${describeCombatTarget(target, combatIndex, combatTargets.length)}`;
  }

  function announceBrowsedTarget(text) {
    if (!text) return;
    if (targetSpeech.enqueue(text)) announce(text, true, false);
    else announce(text, true);
  }

  function announceTargetMenuStart(text) {
    if (targetSpeech.resetAndSpeak(text)) announce(text, true, false);
    else announce(text, true);
  }

  function openLocations() {
    menuLevel = "locations";
    cursor = 0;
    targets = availableTargets();
    const currentLocationId = spatialLocationIdFromNavigationTargetId(getNavigationTargetId());
    if (currentLocationId) {
      const selected = targets.findIndex(target => target.locationId === currentLocationId);
      if (selected >= 0) cursor = selected;
    }
    const target = refresh();
    announceTargetMenuStart(
      target
        ? `Локации. ${describe(target)} Листай и подтверди нужную локацию.`
        : "Подменю локаций пусто: сервер пока не зарегистрировал ни одной локации.",
    );
    render();
  }

  function openMenu() {
    const world = getWorld();
    const playerIndex = getPlayerIndex();
    const combat = world?.players?.[playerIndex]?.combat;
    releaseMovement();
    open = true;
    menuLevel = "root";
    targets = availableTargets();
    const lockedId = combat?.lockedTargetId || getTargetId();
    const navigationTargetId = getNavigationTargetId() || "objective";
    const locationSelected = Boolean(spatialLocationIdFromNavigationTargetId(navigationTargetId));
    const navigationId = locationSelected ? "navigation-locations" : `navigation-${navigationTargetId}`;
    const selectedIndex = targets.findIndex(target => target.id === lockedId);
    const navigationIndex = targets.findIndex(target => target.id === navigationId);
    cursor = selectedIndex >= 0 ? selectedIndex : navigationIndex >= 0 ? navigationIndex : 0;
    const target = refresh();
    announceTargetMenuStart(
      target
        ? `Выбор цели. ${describe(target)} Листай, подтверди нужную или отмени выбор.`
        : combatMenuActive(world)
          ? "Бой ещё отмечен активным, но живых физических целей сервер сейчас не видит."
          : "Доступных целей сейчас нет.",
    );
  }

  function close(announceCancellation = false) {
    targetSpeech.clear();
    open = false;
    menuLevel = "root";
    targets = [];
    cursor = 0;
    if (announceCancellation) announce("Выбор цели отменён. Предыдущие цели сохранены.");
    render();
  }

  function cycle(direction) {
    if (!open) return;
    cursor += direction;
    const target = refresh();
    announceBrowsedTarget(describe(target));
  }

  function reportCurrent() {
    if (!open) return false;
    const target = refresh();
    announceBrowsedTarget(target ? describe(target) : describe(null));
    return Boolean(target);
  }

  function confirm() {
    if (!open) return;
    const target = refresh();
    if (!target) {
      announce(menuLevel === "locations" ? "Локацию подтвердить нельзя: список пуст." : "Цель подтвердить нельзя: доступных целей нет.", true);
      return;
    }
    if (target.menuKind === "submenu" && target.submenu === "locations") {
      openLocations();
      return;
    }
    if (target.menuKind === "navigation") {
      targetSpeech.clear();
      setNavigationTargetId(target.navigationTargetId);
      const locationId = spatialLocationIdFromNavigationTargetId(target.navigationTargetId);
      open = false;
      menuLevel = "root";
      targets = [];
      cursor = 0;
      sendInput();
      announce(
        locationId
          ? `Локация выбрана: ${target.label}. Обычный сонар теперь ведёт ко входу.`
          : `Навигационная цель выбрана: ${target.label}. Обычный сонар теперь ведёт к ней.`,
        true,
      );
      render();
      return;
    }
    targetSpeech.clear();
    setTargetId(target.id);
    open = false;
    menuLevel = "root";
    targets = [];
    cursor = 0;
    sendInput();
    announce(`Навожусь на цель: ${target.label}. Огонь начнётся только после отдельной команды атаки.`, true);
    render();
  }

  return {
    open: openMenu,
    close,
    cycle,
    reportCurrent,
    confirm,
    isOpen: () => open,
    snapshot: () => ({
      open,
      menuLevel,
      cursor,
      targets: targets.map(target => target.id),
      navigationTargetId: getNavigationTargetId(),
    }),
  };
}
