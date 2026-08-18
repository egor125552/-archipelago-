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
    announce(
      target
        ? `Локации. ${describe(target)} Листай и подтверди нужную локацию.`
        : "Подменю локаций пусто: сервер пока не зарегистрировал ни одной локации.",
      true,
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
    announce(
      target
        ? `Выбор цели. ${describe(target)} Листай, подтверди нужную или отмени выбор.`
        : combatMenuActive(world)
          ? "Бой ещё отмечен активным, но живых физических целей сервер сейчас не видит."
          : "Доступных целей сейчас нет.",
      true,
    );
  }

  function close(announceCancellation = false) {
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
    announce(describe(target), true);
  }

  function reportCurrent() {
    if (!open) return false;
    const target = refresh();
    announce(target ? describe(target) : describe(null), true);
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
