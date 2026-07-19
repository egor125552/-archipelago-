"use strict";

import {
  CARGO_ACTION_RANGE,
  LANDING_MAX_X,
  LANDING_MIN_X,
  SHORE_Y,
  clampCargoCoordinate,
  isBoatDockPosition,
} from "./free-roam-cargo-rules.js?v=32";

const LANDING_Y = 88;
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

export function cargoNavigationTarget(player, crate, label) {
  if (player?.mode !== "boat" || crate.y > SHORE_Y) {
    return {id: crate.id, kind: crate.kind, label, x: crate.x, y: crate.y};
  }
  return {
    id: `landing-${crate.id}`,
    kind: "landing",
    crateId: crate.id,
    label: `береговая высадка к цели: ${label}`,
    x: clampCargoCoordinate(crate.x, LANDING_MIN_X, LANDING_MAX_X),
    y: LANDING_Y,
  };
}

function arrivalLimit(player, target) {
  if (target.kind === "landing") return 15;
  return CARGO_ACTION_RANGE;
}

function arrivalText(player, target) {
  if (target.kind === "landing") {
    return "Двойной сигнал. Остановись у береговой высадки и нажми F. Потом сонар поведёт к ящику.";
  }
  if (target.kind === "dock") {
    return "Двойной сигнал. Остановись у причала — груз разгрузится автоматически.";
  }
  if (player?.mode === "boat") {
    return "Двойной сигнал. Остановись и нажми F, чтобы закрепить ящик на лодке.";
  }
  return "Двойной сигнал. Нажми F, чтобы взять ящик в руки.";
}

export function updateCargoArrivalGuidance(world, emit) {
  const scenario = world.freeScenario;
  scenario.arrivalTargets ||= Array.from({length: world.players.length}, () => null);
  scenario.arrivalInside ||= Array.from({length: world.players.length}, () => false);
  while (scenario.arrivalTargets.length < world.players.length) scenario.arrivalTargets.push(null);
  while (scenario.arrivalInside.length < world.players.length) scenario.arrivalInside.push(false);

  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    const target = scenario.targets[index];
    const targetId = target?.id || null;
    const boat = player?.mode === "boat" ? world.boats[player.activeBoat] : null;
    const inside = Boolean(
      target
      && (
        target.kind === "dock" && boat
          ? isBoatDockPosition(boat)
          : distance(player, target) <= arrivalLimit(player, target)
      ),
    );
    const sameTarget = scenario.arrivalTargets[index] === targetId;
    if (inside && (!sameTarget || !scenario.arrivalInside[index])) {
      emit(world, "scenario-arrival", arrivalText(player, target), [index], {
        sourcePlayer: index,
        targetId,
        targetKind: target.kind,
        x: target.x,
        y: target.y,
      });
    }
    scenario.arrivalTargets[index] = targetId;
    scenario.arrivalInside[index] = inside;
  }
}
