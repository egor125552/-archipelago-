"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;

function playerBoat(world, playerIndex) {
  const player = world.players?.[playerIndex];
  return player?.mode === "boat" && Number.isInteger(player.activeBoat)
    ? world.boats?.[player.activeBoat] || null
    : null;
}

function bearingTo(from, target) {
  return Math.atan2(target.x - from.x, -(target.y - from.y)) * 180 / Math.PI;
}

export function ensureSonarGuide(world) {
  const scenario = world.freeScenario;
  scenario.guideEnabled ||= Array.from({length: world.players?.length || 2}, () => false);
  while (scenario.guideEnabled.length < world.players.length) scenario.guideEnabled.push(false);
  return scenario;
}

function toggleGuide(world, playerIndex, emit) {
  const scenario = ensureSonarGuide(world);
  const target = scenario.targets?.[playerIndex];
  if (!target) {
    emit(world, "sonar-guide-unavailable", "Сонар пока не выбрал цель для мягкого курса.", [playerIndex], {sourcePlayer: playerIndex});
    return;
  }
  scenario.guideEnabled[playerIndex] = !scenario.guideEnabled[playerIndex];
  const enabled = scenario.guideEnabled[playerIndex];
  const boat = playerBoat(world, playerIndex);
  if (boat) boat.sonarGuideSteer = 0;
  emit(
    world,
    enabled ? "sonar-guide-on" : "sonar-guide-off",
    enabled
      ? `Мягкий курс к цели включён: ${target.label}. Лодка лишь слегка доворачивает; газ и скорость остаются у тебя.`
      : "Мягкий курс к цели выключен.",
    [playerIndex],
    {sourcePlayer: playerIndex, targetId: target.id, x: target.x, y: target.y},
  );
}

export function updateSonarGuide(world, emit) {
  const scenario = ensureSonarGuide(world);
  const inputs = world.freeActivities?.inputs || [];
  const previous = world.freeActivities?.previousInputs || [];

  for (let index = 0; index < world.players.length; index += 1) {
    if (inputs[index]?.guide && !previous[index]?.guide) toggleGuide(world, index, emit);

    const boat = playerBoat(world, index);
    if (!boat) continue;
    const target = scenario.targets?.[index];
    const manualSteer = Boolean(inputs[index]?.left || inputs[index]?.right);
    if (!scenario.guideEnabled[index] || !target || manualSteer) {
      boat.sonarGuideSteer = 0;
      boat.sonarGuideTargetId = null;
      continue;
    }

    const error = wrapDeg(bearingTo(boat, target) - (Number(boat.heading) || 0));
    boat.sonarGuideSteer = Math.abs(error) <= 7 ? 0 : clamp(error / 140, -0.28, 0.28);
    boat.sonarGuideTargetId = target.id;
  }
}
