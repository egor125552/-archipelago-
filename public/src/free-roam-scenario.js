"use strict";

import {cargoNavigationTarget, updateCargoArrivalGuidance} from "./free-roam-cargo-guidance.js?v=38";
import {
  activatePursuerSquad,
  activePursuers,
  isPursuerSquadDefeated,
} from "./free-roam-pursuer-squad.js?v=33";
import {automaticCargoDelivered} from "./free-roam-weapon-crates.js?v=32";
import {activeHostileGunners} from "./free-roam-hostile-gunners.js?v=32";
import {ensureSonarGuide, updateSonarGuide} from "./free-roam-sonar-guide.js?v=35";
import {merchantNavigationTarget} from "./free-roam-shop.js?v=3";
import {contractNavigationTarget, encounterActive, ensureContracts} from "./free-roam-contracts.js?v=3";
import {activeEnemyBoats} from "./free-roam-enemy-boats.js?v=3";
import {activeHostileActors} from "./free-roam-hostile-actors.js?v=2";

const TARGET_LABELS = Object.freeze({
  plates: "ящик с пластинами",
  fuel: "ящик с топливом",
  pump: "ящик с усилителем насоса",
  valuable: "ящик с припасами",
  automatic: "ящик с автоматом",
  ammo: "ящик с патронами",
  knife: "ящик с ножом",
});

const SALVAGE_KINDS = new Set(["plates", "fuel", "pump", "valuable"]);
const ARM_TARGET_MODES = Object.freeze(["automatic", "knife"]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export function createFreeScenario(playerCount = 2) {
  return {
    phase: "salvage",
    warningUntil: 0,
    announced: false,
    targets: Array.from({length: playerCount}, () => null),
    lockedTargetIds: Array.from({length: playerCount}, () => null),
    beaconUntil: Array.from({length: playerCount}, () => 0),
    sonarCooldown: Array.from({length: playerCount}, () => 0),
    lockedPursuerIds: Array.from({length: playerCount}, () => null),
    guideEnabled: Array.from({length: playerCount}, () => false),
    armTargetModes: Array.from({length: playerCount}, () => "automatic"),
    armSonarReported: Array.from({length: playerCount}, () => false),
    navigationModes: Array.from({length: playerCount}, () => "objective"),
  };
}

export function ensureFreeScenario(world) {
  const created = !world.freeScenario;
  world.freeScenario ||= createFreeScenario(world.players?.length || 2);
  const scenario = world.freeScenario;
  const playerCount = world.players?.length || 2;
  scenario.phase ||= "salvage";
  scenario.targets ||= Array.from({length: playerCount}, () => null);
  scenario.lockedTargetIds ||= Array.from({length: playerCount}, () => null);
  scenario.beaconUntil ||= Array.from({length: playerCount}, () => 0);
  scenario.sonarCooldown ||= Array.from({length: playerCount}, () => 0);
  scenario.lockedPursuerIds ||= Array.from({length: playerCount}, () => null);
  scenario.armTargetModes ||= Array.from({length: playerCount}, () => "automatic");
  scenario.armSonarReported ||= Array.from({length: playerCount}, () => false);
  scenario.navigationModes ||= Array.from({length: playerCount}, () => "objective");
  while (scenario.targets.length < playerCount) scenario.targets.push(null);
  while (scenario.lockedTargetIds.length < playerCount) scenario.lockedTargetIds.push(null);
  while (scenario.beaconUntil.length < playerCount) scenario.beaconUntil.push(0);
  while (scenario.sonarCooldown.length < playerCount) scenario.sonarCooldown.push(0);
  while (scenario.lockedPursuerIds.length < playerCount) scenario.lockedPursuerIds.push(null);
  while (scenario.armTargetModes.length < playerCount) scenario.armTargetModes.push("automatic");
  while (scenario.armSonarReported.length < playerCount) scenario.armSonarReported.push(false);
  while (scenario.navigationModes.length < playerCount) scenario.navigationModes.push("objective");

  // Remove the temporary pursuit-choice state from older saved worlds. During
  // combat the sonar now has exactly one job: track the assigned pursuer.
  scenario.sonarTargetModes?.fill("primary");
  scenario.sonarHasReportedPursuit?.fill(false);

  ensureSonarGuide(world);
  if (created && scenario.phase === "salvage" && world.freeActivities?.marauder) {
    world.freeActivities.marauder.active = false;
    world.freeActivities.marauder.speed = 0;
  }
  return scenario;
}

function syncNavigationModes(world) {
  const scenario = world.freeScenario;
  const inputs = world.freeActivities?.inputs || [];
  for (let index = 0; index < world.players.length; index += 1) {
    const requested = inputs[index]?.navigationTargetId;
    if (["objective", "merchant", "board"].includes(requested)) scenario.navigationModes[index] = requested;
  }
}

function playerBoat(world, playerIndex) {
  const player = world.players[playerIndex];
  if (Number.isInteger(player?.activeBoat)) return world.boats[player.activeBoat] || null;
  return world.boats.find(boat => boat.owner === playerIndex) || null;
}

function cargoNeedsDock(world, playerIndex, requiredKind = null) {
  const player = world.players[playerIndex];
  const boat = playerBoat(world, playerIndex);
  const carried = world.freeActivities.crates.find(crate => crate.id === player?.combat?.carriedCrate);
  if (carried && (!requiredKind || carried.kind === requiredKind)) return true;
  return (boat?.cargo || []).some(id => {
    const crate = world.freeActivities.crates.find(candidate => candidate.id === id);
    return crate && (!requiredKind || crate.kind === requiredKind);
  });
}

function nearestWorldCrate(world, playerIndex, predicate) {
  const player = world.players[playerIndex];
  let result = null;
  let best = Infinity;
  for (const crate of world.freeActivities.crates) {
    if (crate.state !== "world" || !predicate(crate)) continue;
    const metres = distance(player, crate);
    if (metres < best) {
      result = crate;
      best = metres;
    }
  }
  return result;
}

function lockedWorldCrate(world, playerIndex, predicate) {
  const id = world.freeScenario.lockedTargetIds[playerIndex];
  const crate = world.freeActivities.crates.find(candidate => candidate.id === id);
  return crate?.state === "world" && predicate(crate) ? crate : null;
}

function dockTarget(player) {
  return {
    id: "dock",
    kind: "dock",
    label: "причал для разгрузки",
    x: clamp(Number(player?.x) || 210, 154, 266),
    y: player?.mode === "boat" ? 82 : 65,
  };
}

function knifeAvailable(world, playerIndex) {
  if (world.players[playerIndex]?.combat?.weapons?.knife) return false;
  if (cargoNeedsDock(world, playerIndex, "knife")) return true;
  return Boolean(nearestWorldCrate(world, playerIndex, crate => crate.kind === "knife"));
}

function availableArmModes(world, playerIndex) {
  return knifeAvailable(world, playerIndex) ? ARM_TARGET_MODES : ["automatic"];
}

function cycleArmTargetMode(world, playerIndex) {
  const scenario = world.freeScenario;
  const modes = availableArmModes(world, playerIndex);
  const current = scenario.armTargetModes[playerIndex] || "automatic";
  const currentIndex = Math.max(0, modes.indexOf(current));
  scenario.armTargetModes[playerIndex] = modes[(currentIndex + 1) % modes.length] || "automatic";
}

function armTarget(world, playerIndex) {
  const scenario = world.freeScenario;
  let mode = scenario.armTargetModes[playerIndex] || "automatic";
  if (mode === "knife" && !knifeAvailable(world, playerIndex)) mode = "automatic";
  scenario.armTargetModes[playerIndex] = mode;

  if (cargoNeedsDock(world, playerIndex, mode)) return dockTarget(world.players[playerIndex]);

  const crate = lockedWorldCrate(world, playerIndex, candidate => candidate.kind === mode)
    || nearestWorldCrate(world, playerIndex, candidate => candidate.kind === mode);
  if (crate) return cargoNavigationTarget(world.players[playerIndex], crate, TARGET_LABELS[mode]);

  if (mode !== "automatic") {
    scenario.armTargetModes[playerIndex] = "automatic";
    return armTarget(world, playerIndex);
  }
  return null;
}

export function scenarioTarget(world, playerIndex) {
  const scenario = ensureFreeScenario(world);
  ensureContracts(world);
  if (scenario.phase === "pursuit" || encounterActive(world)) return null;
  if (scenario.phase === "warning") {
    return {id: "open-water", kind: "warning", label: "выход из бухты", x: 210, y: 255};
  }
  if (!encounterActive(world) && scenario.navigationModes?.[playerIndex] === "merchant") return merchantNavigationTarget();
  if (!encounterActive(world) && scenario.navigationModes?.[playerIndex] === "board") return contractNavigationTarget(world, playerIndex);
  if (!encounterActive(world) && world.freeContracts?.activeContract) return contractNavigationTarget(world, playerIndex);
  if (scenario.phase === "arm") return armTarget(world, playerIndex);
  if (scenario.phase === "salvage") {
    if (cargoNeedsDock(world, playerIndex)) return dockTarget(world.players[playerIndex]);
    const crate = lockedWorldCrate(world, playerIndex, candidate => SALVAGE_KINDS.has(candidate.kind))
      || nearestWorldCrate(world, playerIndex, candidate => SALVAGE_KINDS.has(candidate.kind))
      || nearestWorldCrate(world, playerIndex, () => true);
    if (crate) return cargoNavigationTarget(
      world.players[playerIndex],
      crate,
      TARGET_LABELS[crate.kind] || "ящик с припасами",
    );
  }
  if (scenario.phase === "victory") {
    if (cargoNeedsDock(world, playerIndex)) return dockTarget(world.players[playerIndex]);
    if (!world.players[playerIndex]?.combat?.weapons?.knife) {
      const knife = lockedWorldCrate(world, playerIndex, crate => crate.kind === "knife")
        || nearestWorldCrate(world, playerIndex, crate => crate.kind === "knife");
      if (knife) return cargoNavigationTarget(world.players[playerIndex], knife, TARGET_LABELS.knife);
    }
    const prize = nearestWorldCrate(world, playerIndex, crate => crate.source === "pursuer" || crate.source === "marauder");
    if (prize) return {
      id: prize.id,
      kind: prize.kind,
      label: "трофей преследователя",
      x: prize.x,
      y: prize.y,
    };
    const cargo = lockedWorldCrate(world, playerIndex, () => true)
      || nearestWorldCrate(world, playerIndex, () => true);
    if (cargo) return cargoNavigationTarget(
      world.players[playerIndex],
      cargo,
      TARGET_LABELS[cargo.kind] || "ящик с припасами",
    );
    return null;
  }
  return dockTarget(world.players[playerIndex]);
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
  const relative = wrapDeg(absolute - (Number(player.heading) || 0));
  const side = relative < 0 ? "слева" : "справа";
  const amount = Math.abs(relative);
  if (amount <= 10) return "прямо";
  if (amount >= 165) return "сзади";
  if (amount >= 110) return `сзади ${side}`;
  return side;
}

function updateLockedTarget(scenario, playerIndex, target) {
  if (target?.id?.startsWith("crate-")) scenario.lockedTargetIds[playerIndex] = target.id;
  else if (target?.kind === "landing" && target.crateId) scenario.lockedTargetIds[playerIndex] = target.crateId;
}

function updateTargets(world) {
  const scenario = world.freeScenario;
  for (let index = 0; index < world.players.length; index += 1) {
    const previous = scenario.targets[index];
    const target = scenarioTarget(world, index);
    scenario.targets[index] = target;
    updateLockedTarget(scenario, index, target);
  }
}

function handleSonar(world, dt) {
  const scenario = world.freeScenario;
  const inputs = world.freeActivities.inputs;
  const previous = world.freeActivities.previousInputs;
  for (let index = 0; index < world.players.length; index += 1) {
    scenario.sonarCooldown[index] = Math.max(0, scenario.sonarCooldown[index] - dt);
    if (!inputs[index]?.sonar || previous[index]?.sonar || scenario.sonarCooldown[index] > 0) continue;

    if (scenario.phase === "pursuit" || encounterActive(world)) {
      scenario.sonarCooldown[index] = 1.1;
      emit(world, "scenario-sonar-combat", "Навигационный сонар приостановлен на время боя. Открой выбор боевой цели.", [index], {sourcePlayer: index});
      continue;
    }

    if (scenario.phase === "arm") {
      if (scenario.armSonarReported[index]) cycleArmTargetMode(world, index);
      else scenario.armSonarReported[index] = true;
      scenario.targets[index] = scenarioTarget(world, index);
      updateLockedTarget(scenario, index, scenario.targets[index]);
    }

    const target = scenario.targets[index];
    if (!target) {
      scenario.sonarCooldown[index] = 1.1;
      emit(world, "scenario-sonar-empty", "Сонар: доступных целей сейчас нет.", [index], {sourcePlayer: index});
      continue;
    }
    const metres = distance(world.players[index], target);
    scenario.sonarCooldown[index] = 1.1;
    scenario.beaconUntil[index] = Number.MAX_SAFE_INTEGER;
    emit(
      world,
      "scenario-sonar",
      `Сонар: цель — ${target.label}, ${Math.round(metres)} метров, ${directionText(world.players[index], target)}.`,
      [index],
      {
        sourcePlayer: index,
        targetId: target.id,
        targetKind: target.kind,
        sonarTargetMode: scenario.phase === "arm" ? scenario.armTargetModes[index] : "primary",
        x: target.x,
        y: target.y,
        distance: metres,
      },
    );
  }
}

function activatePursuer(world) {
  const pursuer = world.freeActivities.marauder;
  const target = playerBoat(world, 0) || world.boats[0];
  pursuer.x = clamp(target.x + 105, 18, 402);
  pursuer.y = clamp(target.y + 82, 92, 302);
  pursuer.heading = 315;
  pursuer.speed = 0;
  pursuer.hull = 72;
  pursuer.active = true;
  pursuer.destroyed = false;
  pursuer.ramCooldown = 4;
  pursuer.recoveryRemaining = 0;
  pursuer.respawnAt = 0;
  activatePursuerSquad(world);
  world.freeScenario.armTargetModes.fill("automatic");
  world.freeScenario.armSonarReported.fill(false);
  emit(world, "pursuer-arrival", "В бухту вошли три катера-преследователя. Сонар держит назначенную боевую цель. Уклоняйся от физических пуль и уничтожь все три.", [0, 1], {
    x: pursuer.x,
    y: pursuer.y,
  });
}

function updatePhase(world) {
  const scenario = world.freeScenario;
  const delivered = world.freeActivities.delivered.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const automaticDelivered = automaticCargoDelivered(world);

  if (scenario.phase === "salvage" && delivered >= 2) {
    scenario.phase = "arm";
    scenario.armTargetModes.fill("automatic");
    scenario.armSonarReported.fill(false);
    emit(world, "scenario-objective", "Первая задача выполнена. Теперь доставь ящик с автоматом. До начала погони можно забрать нож: повторное нажатие сонара переключает между автоматом и ножом.", [0, 1]);
  }
  if (scenario.phase === "arm" && automaticDelivered) {
    scenario.phase = "warning";
    scenario.warningUntil = world.time + 8;
    emit(world, "pursuer-warning", "Автомат получен. Через восемь секунд появятся катера-преследователи. Выходи на открытую воду.", [0, 1]);
  }
  if (scenario.phase === "warning" && world.time >= scenario.warningUntil) {
    scenario.phase = "pursuit";
    activatePursuer(world);
  }
  const pursuer = world.freeActivities.marauder;
  if (
    scenario.phase === "pursuit"
    && isPursuerSquadDefeated(world)
    && activeHostileGunners(world).length === 0
  ) {
    scenario.phase = "victory";
    pursuer.respawnAt = 0;
    emit(world, "scenario-victory", "Все три катера уничтожены. Сценарий пройден; забери разные трофеи и продолжай исследовать бухту.", [0, 1]);
  }
}

export function updateFreeScenario(world, dt) {
  const scenario = ensureFreeScenario(world);
  if (!scenario.announced) {
    scenario.announced = true;
    emit(world, "scenario-objective", "Задача: доставь два обычных ящика. Сонар Q называет одну цель. Подойди к ящику ближе 12 метров и нажми F. После погрузки снова нажми Q, доедь до причала и остановись — разгрузка автоматическая.", [0, 1]);
  }
  updatePhase(world);
  syncNavigationModes(world);
  updateTargets(world);
  handleSonar(world, dt);
  updateSonarGuide(world, emit);
  updateCargoArrivalGuidance(world, emit);
}

export function scenarioStatus(world, playerIndex) {
  const scenario = ensureFreeScenario(world);
  const target = scenario.targets[playerIndex] || scenarioTarget(world, playerIndex);
  const delivered = world.freeActivities.delivered.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const remainingSalvage = Math.max(0, 2 - delivered);
  const phases = {
    salvage: `Задача: доставь ещё ${remainingSalvage === 1 ? "один обычный ящик" : "два обычных ящика"}.`,
    arm: "Задача: доставь автомат. До погони можно забрать нож; повторное нажатие сонара переключает цель.",
    warning: `Преследователи появятся через ${Math.max(0, Math.ceil(scenario.warningUntil - world.time))} секунд.`,
    pursuit: `Задача: уничтожь все катера и высадившихся стрелков. Катеров осталось ${activePursuers(world).length + activeEnemyBoats(world).length}, стрелков ${activeHostileGunners(world).length + activeHostileActors(world).length}.`,
    victory: world.freeContracts?.activeContract
      ? `Заказ: ${world.freeContracts.activeContract.label}. Этап ${world.freeContracts.activeContract.phase}.`
      : "Сценарий пройден. Доска заказов доступна у торговца.",
  };
  if (!target) return phases[scenario.phase] || "";
  const guide = scenario.guideEnabled?.[playerIndex] ? " Мягкий курс включён." : "";
  return `${phases[scenario.phase] || ""} Цель сонара: ${target.label}, ${Math.round(distance(world.players[playerIndex], target))} метров.${guide}`;
}
