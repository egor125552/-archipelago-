"use strict";

import {
  ensureFreeScenario as ensureBaseScenario,
  scenarioStatus as baseScenarioStatus,
  updateFreeScenario as updateBaseScenario,
} from "./free-roam-scenario.js?v=39";
import {cargoNavigationTarget, updateCargoArrivalGuidance} from "./free-roam-cargo-guidance.js?v=38";
import {updateSonarGuide} from "./free-roam-sonar-guide.js?v=35";

const ARM_MODES = Object.freeze(["automatic", "knife"]);
const TARGET_LABELS = Object.freeze({
  automatic: "ящик с автоматом",
  knife: "ящик с ножом",
});
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensureChoiceState(world) {
  const count = world.players?.length || 2;
  world.freeArmSonar ||= {
    phase: null,
    modes: Array.from({length: count}, () => "automatic"),
    reported: Array.from({length: count}, () => false),
  };
  const state = world.freeArmSonar;
  state.modes ||= Array.from({length: count}, () => "automatic");
  state.reported ||= Array.from({length: count}, () => false);
  while (state.modes.length < count) state.modes.push("automatic");
  while (state.reported.length < count) state.reported.push(false);
  return state;
}

function playerBoat(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (Number.isInteger(player?.activeBoat)) return world.boats?.[player.activeBoat] || null;
  return world.boats?.find(boat => boat.owner === playerIndex) || null;
}

function cargoNeedsDock(world, playerIndex, kind) {
  const player = world.players?.[playerIndex];
  const boat = playerBoat(world, playerIndex);
  const carried = world.freeActivities?.crates?.find(crate => crate.id === player?.combat?.carriedCrate);
  if (carried?.kind === kind) return true;
  return (boat?.cargo || []).some(id => world.freeActivities?.crates?.find(crate => crate.id === id)?.kind === kind);
}

function nearestWorldCrate(world, playerIndex, kind) {
  const player = world.players?.[playerIndex];
  let result = null;
  let best = Infinity;
  for (const crate of world.freeActivities?.crates || []) {
    if (crate.state !== "world" || crate.kind !== kind) continue;
    const metres = distance(player, crate);
    if (metres < best) {
      result = crate;
      best = metres;
    }
  }
  return result;
}

function knifeAvailable(world, playerIndex) {
  if (world.players?.[playerIndex]?.combat?.weapons?.knife) return false;
  return cargoNeedsDock(world, playerIndex, "knife") || Boolean(nearestWorldCrate(world, playerIndex, "knife"));
}

function availableArmModes(world, playerIndex) {
  return knifeAvailable(world, playerIndex) ? ARM_MODES : ["automatic"];
}

function cycleArmMode(world, playerIndex) {
  const state = ensureChoiceState(world);
  const modes = availableArmModes(world, playerIndex);
  const current = state.modes[playerIndex] || "automatic";
  const index = Math.max(0, modes.indexOf(current));
  state.modes[playerIndex] = modes[(index + 1) % modes.length] || "automatic";
}

function dockTarget(player) {
  return {
    id: "dock",
    kind: "dock",
    label: "причал для разгрузки",
    x: Math.max(154, Math.min(266, Number(player?.x) || 210)),
    y: player?.mode === "boat" ? 82 : 65,
  };
}

function targetForArmMode(world, playerIndex, requestedMode) {
  let mode = requestedMode;
  if (mode === "knife" && !knifeAvailable(world, playerIndex)) mode = "automatic";
  if (cargoNeedsDock(world, playerIndex, mode)) return {mode, target: dockTarget(world.players[playerIndex])};
  const crate = nearestWorldCrate(world, playerIndex, mode);
  if (!crate && mode !== "automatic") return targetForArmMode(world, playerIndex, "automatic");
  return {
    mode,
    target: crate ? cargoNavigationTarget(world.players[playerIndex], crate, TARGET_LABELS[mode]) : null,
  };
}

function directionText(player, target) {
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  if (["foot", "swim"].includes(player?.mode)) {
    const horizontal = dx < 0 ? "слева" : "справа";
    const vertical = dy < 0 ? "вглубь берега" : "в сторону воды";
    if (Math.abs(dx) < 3) return vertical;
    if (Math.abs(dy) < 3) return horizontal;
    return `${horizontal} и ${vertical}`;
  }
  const absolute = Math.atan2(dx, -dy) * 180 / Math.PI;
  const relative = wrapDeg(absolute - (Number(player?.heading) || 0));
  const side = relative < 0 ? "слева" : "справа";
  const amount = Math.abs(relative);
  if (amount <= 10) return "прямо";
  if (amount >= 165) return "сзади";
  if (amount >= 110) return `сзади ${side}`;
  return side;
}

function targetEventForPlayer(events, playerIndex) {
  return events.find(event => event.type === "scenario-sonar" && event.targets?.includes(playerIndex)) || null;
}

function removeFreshNavigationEvents(world, eventStart) {
  const removable = new Set(["scenario-sonar", "scenario-arrival", "sonar-guide-snap", "sonar-guide-unavailable"]);
  const before = world.events.slice(0, eventStart);
  const after = world.events.slice(eventStart).filter(event => !removable.has(event.type));
  world.events = before.concat(after);
}

function rewriteFreshMessages(world, eventStart) {
  for (const event of world.events.slice(eventStart)) {
    if (event.type === "scenario-objective" && event.text?.startsWith("Первая задача выполнена.")) {
      event.text = "Первая задача выполнена. Теперь доставь ящик с автоматом. До начала погони можно забрать нож: повторное нажатие сонара переключает между автоматом и ножом.";
    }
    if (event.type === "pursuer-arrival") {
      event.text = "В бухту вошли три катера-преследователя. Сонар держит назначенную боевую цель. Уклоняйся от физических пуль и уничтожь все три.";
    }
    if (event.type === "scenario-sonar") {
      event.text = event.text
        ?.replace("Сонар: основная цель — ", "Сонар: цель — ")
        .replace("Сонар: дополнительная цель — ", "Сонар: цель — ");
    }
  }
}

function resetLegacyPursuitChoices(world) {
  const scenario = world.freeScenario;
  if (!scenario || scenario.phase !== "pursuit") return;
  scenario.sonarTargetModes?.fill("primary");
  scenario.sonarHasReportedPursuit?.fill(false);
}

export function ensureFreeScenario(world) {
  const scenario = ensureBaseScenario(world);
  ensureChoiceState(world);
  resetLegacyPursuitChoices(world);
  return scenario;
}

export function updateFreeScenario(world, dt) {
  const state = ensureChoiceState(world);
  resetLegacyPursuitChoices(world);
  const eventStart = world.events?.length || 0;
  updateBaseScenario(world, dt);
  const freshEvents = world.events.slice(eventStart);
  const phase = world.freeScenario?.phase;

  if (state.phase !== phase) {
    state.phase = phase;
    state.modes.fill("automatic");
    state.reported.fill(false);
  }

  rewriteFreshMessages(world, eventStart);
  resetLegacyPursuitChoices(world);

  if (phase !== "arm") return;

  const sonarEvents = world.players.map((_, index) => targetEventForPlayer(freshEvents, index));
  for (let index = 0; index < world.players.length; index += 1) {
    if (sonarEvents[index]) {
      if (state.reported[index]) cycleArmMode(world, index);
      else state.reported[index] = true;
    }
    const resolved = targetForArmMode(world, index, state.modes[index]);
    state.modes[index] = resolved.mode;
    world.freeScenario.targets[index] = resolved.target;
    if (resolved.target?.id?.startsWith("crate-")) world.freeScenario.lockedTargetIds[index] = resolved.target.id;
    else if (resolved.target?.kind === "landing" && resolved.target.crateId) {
      world.freeScenario.lockedTargetIds[index] = resolved.target.crateId;
    }
  }

  removeFreshNavigationEvents(world, eventStart);

  for (let index = 0; index < world.players.length; index += 1) {
    if (!sonarEvents[index]) continue;
    const target = world.freeScenario.targets[index];
    if (!target) {
      emit(world, "scenario-sonar-empty", "Сонар: доступных целей сейчас нет.", [index], {sourcePlayer: index});
      continue;
    }
    const metres = distance(world.players[index], target);
    emit(
      world,
      "scenario-sonar",
      `Сонар: цель — ${target.label}, ${Math.round(metres)} метров, ${directionText(world.players[index], target)}.`,
      [index],
      {
        sourcePlayer: index,
        targetId: target.id,
        targetKind: target.kind,
        sonarTargetMode: state.modes[index],
        x: target.x,
        y: target.y,
        distance: metres,
      },
    );
  }

  updateSonarGuide(world, emit);
  updateCargoArrivalGuidance(world, emit);
}

export function scenarioStatus(world, playerIndex) {
  const scenario = ensureFreeScenario(world);
  if (scenario.phase !== "arm") {
    return baseScenarioStatus(world, playerIndex).replace(" Дополнительная цель выбрана.", "");
  }
  const target = scenario.targets[playerIndex];
  const guide = scenario.guideEnabled?.[playerIndex] ? " Мягкий курс включён." : "";
  const targetText = target
    ? ` Цель сонара: ${target.label}, ${Math.round(distance(world.players[playerIndex], target))} метров.`
    : "";
  return `Задача: доставь автомат. Нож можно забрать до начала погони; повторное нажатие сонара переключает цель.${targetText}${guide}`;
}
