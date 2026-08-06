"use strict";

const REPAIR_DURATION = 3.1;
const STRUCTURE_REPAIR_POINTS = 30;
const ARMOR_REPAIR_POINTS = 40;
const LEAK_REPAIR_POINTS = 3.2;
const REPAIR_SPEED_LIMIT = 1.8;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

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

function targetsForBoat(boat) {
  const crew = (boat?.crew || []).filter(Number.isInteger);
  return crew.length ? crew : [0, 1];
}

export function prepareDualTurretDamageControlStep(world, boatContext) {
  const boat = boatContext?.boat;
  const originals = boatContext?.originals || [];
  const requested = Boolean((boat?.crew || [])
    .filter(Number.isInteger)
    .some(playerIndex => originals[playerIndex]?.repair));
  const saved = [];

  // The shared boat owns a point-based hull and a separate armor pool. The
  // legacy 100-percent repair routine cannot repair that model, so only its
  // repair input is suppressed. Pumping remains in the common boat physics.
  if (Number.isInteger(boat?.driver)) {
    for (const input of inputObjects(world, boat.driver)) {
      saved.push([input, input.repair]);
      input.repair = false;
    }
  }
  return {boat, requested, saved};
}

function restoreInputs(context) {
  for (let index = context.saved.length - 1; index >= 0; index -= 1) {
    const [input, value] = context.saved[index];
    input.repair = value;
  }
}

function resetRepair(boat) {
  if (!boat) return;
  boat.dualRepairProgress = 0;
  boat.dualRepairQuarter = 0;
}

export function finishDualTurretDamageControlStep(world, context, dt) {
  restoreInputs(context);
  const boat = context.boat;
  if (!boat || boat.sunk || boat.reserved || !context.requested) {
    resetRepair(boat);
    if (boat) boat.dualRepairHeld = false;
    return boat;
  }

  const targets = targetsForBoat(boat);
  const rising = !boat.dualRepairHeld;
  boat.dualRepairHeld = true;
  if (rising) {
    emit(world, "hull-repair-start", "Заделка бронекатера началась.", targets, {
      boatId: boat.id,
      x: boat.x,
      y: boat.y,
    });
  }

  if ((Number(boat.repairPatches) || 0) <= 0) {
    if (rising || (Number(world.time) || 0) - (Number(boat.dualRepairBlockedAt) || -999) >= 1.5) {
      boat.dualRepairBlockedAt = Number(world.time) || 0;
      emit(world, "repair-blocked", "Ремонтные пластины закончились.", targets, {boatId: boat.id});
    }
    resetRepair(boat);
    return boat;
  }

  const maximumHull = Math.max(1, Number(boat.maxStructuralHull) || 300);
  const maximumArmor = Math.max(0, Number(boat.armorMax) || 200);
  const damaged = (Number(boat.structuralHull) || 0) < maximumHull - 0.01
    || (Number(boat.armor) || 0) < maximumArmor - 0.01
    || (Number(boat.leak) || 0) > 0.05;
  if (!damaged) {
    if (rising) emit(world, "repair-blocked", "Корпус, броня и герметичность бронекатера уже в порядке.", targets, {boatId: boat.id});
    resetRepair(boat);
    return boat;
  }

  const towed = world.tow?.towedBoat === boat.id;
  if (Math.abs(Number(boat.speed) || 0) > REPAIR_SPEED_LIMIT && !towed) {
    boat.dualRepairProgress = Math.max(0, (Number(boat.dualRepairProgress) || 0) - Math.max(0, Number(dt) || 0) * 0.7);
    boat.dualRepairQuarter = Math.min(3, Math.floor(boat.dualRepairProgress / REPAIR_DURATION * 4));
    return boat;
  }

  boat.dualRepairProgress = (Number(boat.dualRepairProgress) || 0) + Math.max(0, Number(dt) || 0);
  const quarter = Math.min(4, Math.floor(boat.dualRepairProgress / REPAIR_DURATION * 4));
  if (quarter > (Number(boat.dualRepairQuarter) || 0) && quarter < 4) {
    boat.dualRepairQuarter = quarter;
    emit(world, "hull-repair-progress", `Заделка бронекатера: ${quarter * 25} процентов.`, targets, {
      boatId: boat.id,
      percent: quarter * 25,
    });
  }
  if (boat.dualRepairProgress < REPAIR_DURATION) return boat;

  boat.structuralHull = clamp((Number(boat.structuralHull) || 0) + STRUCTURE_REPAIR_POINTS, 0, maximumHull);
  boat.armor = clamp((Number(boat.armor) || 0) + ARMOR_REPAIR_POINTS, 0, maximumArmor);
  boat.leak = clamp((Number(boat.leak) || 0) - LEAK_REPAIR_POINTS, 0, 16);
  boat.hull = clamp(boat.structuralHull / maximumHull * 100, 0, 100);
  boat.repairPatches = Math.max(0, Math.floor(Number(boat.repairPatches) || 0) - 1);
  resetRepair(boat);
  emit(world, "hull-repair-complete", `Пластина закреплена. Броня ${Math.round(boat.armor)} из ${Math.round(maximumArmor)}, корпус ${Math.round(boat.structuralHull)} из ${Math.round(maximumHull)}, пластин осталось ${boat.repairPatches}.`, targets, {
    boatId: boat.id,
    armor: boat.armor,
    structuralHull: boat.structuralHull,
    repairPatches: boat.repairPatches,
    x: boat.x,
    y: boat.y,
  });
  return boat;
}
