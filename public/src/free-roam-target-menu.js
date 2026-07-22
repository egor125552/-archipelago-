"use strict";

import {describeCombatTarget, listCombatTargets} from "./free-roam-targeting.js?v=32";

export function createTargetMenu({
  getWorld,
  getPlayerIndex,
  getTargetId,
  setTargetId,
  releaseMovement,
  sendInput,
  announce,
  render,
}) {
  let open = false;
  let cursor = 0;
  let targets = [];

  function refresh() {
    const selectedId = targets[cursor]?.id || null;
    const world = getWorld();
    targets = world ? listCombatTargets(world, getPlayerIndex(), 420) : [];
    if (!targets.length) {
      cursor = 0;
      return null;
    }
    const refreshedIndex = selectedId
      ? targets.findIndex(target => target.id === selectedId)
      : -1;
    cursor = refreshedIndex >= 0
      ? refreshedIndex
      : ((cursor % targets.length) + targets.length) % targets.length;
    return targets[cursor];
  }

  function openMenu() {
    const world = getWorld();
    const playerIndex = getPlayerIndex();
    const combat = world?.players?.[playerIndex]?.combat;
    if (!combat?.weapons?.automatic || combat.ammo <= 0) {
      announce("Для выбора цели сначала нужен автомат с патронами.", true);
      return;
    }
    releaseMovement();
    open = true;
    targets = listCombatTargets(world, playerIndex, 420);
    const lockedId = combat.lockedTargetId || getTargetId();
    const lockedIndex = targets.findIndex(target => target.id === lockedId);
    cursor = lockedIndex >= 0 ? lockedIndex : 0;
    const target = refresh();
    announce(
      target
        ? `Выбор цели. ${describeCombatTarget(target, cursor, targets.length)} Листай цели, подтверди нужную или отмени выбор.`
        : "В радиусе стрельбы сейчас нет доступных целей.",
      true,
    );
  }

  function close(announceCancellation = false) {
    open = false;
    targets = [];
    cursor = 0;
    if (announceCancellation) announce("Выбор цели отменён. Предыдущий захват сохранён.");
    render();
  }

  function cycle(direction) {
    if (!open) return;
    cursor += direction;
    const target = refresh();
    announce(
      target
        ? describeCombatTarget(target, cursor, targets.length)
        : "Доступных целей больше нет.",
      true,
    );
  }

  function confirm() {
    if (!open) return;
    const target = refresh();
    if (!target) {
      announce("Цель подтвердить нельзя: доступных целей нет.", true);
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
    snapshot: () => ({open, cursor, targets: targets.map(target => target.id)}),
  };
}
