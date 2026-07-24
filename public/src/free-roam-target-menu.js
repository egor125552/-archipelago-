"use strict";

import {describeCombatTarget, listCombatTargets} from "./free-roam-targeting.js?v=34";
import {encounterActive} from "./free-roam-contracts.js?v=2";

const NAVIGATION_ENTRIES = Object.freeze([
  Object.freeze({id: "navigation-objective", menuKind: "navigation", navigationTargetId: "objective", label: "текущая задача"}),
  Object.freeze({id: "navigation-merchant", menuKind: "navigation", navigationTargetId: "merchant", label: "торговый причал"}),
  Object.freeze({id: "navigation-board", menuKind: "navigation", navigationTargetId: "board", label: "доска заказов"}),
]);

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
  let cursor = 0;
  let targets = [];

  function availableTargets() {
    const world = getWorld();
    const playerIndex = getPlayerIndex();
    const combat = world?.players?.[playerIndex]?.combat;
    const rangedReady = Boolean(
      (combat?.weapons?.pistol && combat.pistolAmmo > 0)
      || (combat?.weapons?.automatic && combat.ammo > 0)
    );
    const combatTargets = rangedReady
      ? listCombatTargets(world, playerIndex, 420).map(target => ({...target, menuKind: "combat"}))
      : [];
    if (encounterActive(world)) return combatTargets;
    return [...NAVIGATION_ENTRIES.map(entry => ({...entry})), ...combatTargets];
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
    if (!target) return "Доступных целей больше нет.";
    if (target.menuKind === "navigation") {
      return `Навигация ${cursor + 1} из ${targets.length}: ${target.label}.`;
    }
    const combatTargets = targets.filter(candidate => candidate.menuKind === "combat");
    const combatIndex = Math.max(0, combatTargets.findIndex(candidate => candidate.id === target.id));
    return `Боевая цель. ${describeCombatTarget(target, combatIndex, combatTargets.length)}`;
  }

  function openMenu() {
    const world = getWorld();
    const playerIndex = getPlayerIndex();
    const combat = world?.players?.[playerIndex]?.combat;
    releaseMovement();
    open = true;
    targets = availableTargets();
    const lockedId = combat?.lockedTargetId || getTargetId();
    const navigationId = `navigation-${getNavigationTargetId() || "objective"}`;
    const selectedIndex = targets.findIndex(target => target.id === lockedId);
    const navigationIndex = targets.findIndex(target => target.id === navigationId);
    cursor = selectedIndex >= 0 ? selectedIndex : navigationIndex >= 0 ? navigationIndex : 0;
    const target = refresh();
    announce(
      target
        ? `Выбор цели. ${describe(target)} Листай, подтверди нужную или отмени выбор.`
        : "Доступных целей сейчас нет.",
      true,
    );
  }

  function close(announceCancellation = false) {
    open = false;
    targets = [];
    cursor = 0;
    if (announceCancellation) announce("Выбор цели отменён. Предыдущие цели сохранены.");
    render();
  }

  function cycle(direction) {
    if (!open) return;
    cursor += direction;
    const target = refresh();
    announce(describe(target), true);
  }

  function confirm() {
    if (!open) return;
    const target = refresh();
    if (!target) {
      announce("Цель подтвердить нельзя: доступных целей нет.", true);
      return;
    }
    if (target.menuKind === "navigation") {
      setNavigationTargetId(target.navigationTargetId);
      open = false;
      targets = [];
      cursor = 0;
      sendInput();
      announce(`Навигационная цель выбрана: ${target.label}. Обычный сонар теперь ведёт к ней.`, true);
      render();
      return;
    }
    setTargetId(target.id);
    open = false;
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
    confirm,
    isOpen: () => open,
    snapshot: () => ({
      open,
      cursor,
      targets: targets.map(target => target.id),
      navigationTargetId: getNavigationTargetId(),
    }),
  };
}
