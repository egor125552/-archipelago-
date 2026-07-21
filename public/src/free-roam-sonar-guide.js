"use strict";

function playerBoat(world, playerIndex) {
  const player = world.players?.[playerIndex];
  return player?.mode === "boat" && Number.isInteger(player.activeBoat)
    ? world.boats?.[player.activeBoat] || null
    : null;
}

export function bearingTo(from, target) {
  return Math.atan2(target.x - from.x, -(target.y - from.y)) * 180 / Math.PI;
}

export function ensureSonarGuide(world) {
  const scenario = world.freeScenario;
  scenario.guideEnabled ||= Array.from({length: world.players?.length || 2}, () => false);
  while (scenario.guideEnabled.length < world.players.length) scenario.guideEnabled.push(false);
  // Old saved worlds may still contain the former persistent steering mode.
  // Clear it permanently: guidance is now a one-shot heading snap.
  scenario.guideEnabled.fill(false);
  return scenario;
}

export function turnBoatToSonar(world, playerIndex, emit) {
  const scenario = ensureSonarGuide(world);
  const target = scenario.targets?.[playerIndex];
  if (!target) {
    emit(world, "sonar-guide-unavailable", "Сонар пока не выбрал цель для поворота.", [playerIndex], {sourcePlayer: playerIndex});
    return false;
  }

  const boat = playerBoat(world, playerIndex);
  if (!boat) {
    emit(world, "sonar-guide-unavailable", "Поворот к сонару доступен только когда ты управляешь лодкой.", [playerIndex], {sourcePlayer: playerIndex});
    return false;
  }

  boat.heading = bearingTo(boat, target);
  boat.rudder = 0;
  boat.sonarGuideSteer = 0;
  boat.sonarGuideTargetId = null;
  scenario.guideEnabled[playerIndex] = false;
  emit(
    world,
    "sonar-guide-snap",
    `Лодка мгновенно повёрнута прямо к цели сонара: ${target.label}.`,
    [playerIndex],
    {sourcePlayer: playerIndex, targetId: target.id, x: target.x, y: target.y, heading: boat.heading},
  );
  return true;
}

export function updateSonarGuide(world, emit) {
  const scenario = ensureSonarGuide(world);
  const inputs = world.freeActivities?.inputs || [];
  const previous = world.freeActivities?.previousInputs || [];

  for (let index = 0; index < world.players.length; index += 1) {
    if (inputs[index]?.guide && !previous[index]?.guide) turnBoatToSonar(world, index, emit);

    const boat = playerBoat(world, index);
    if (!boat) continue;
    boat.sonarGuideSteer = 0;
    boat.sonarGuideTargetId = null;
    scenario.guideEnabled[index] = false;
  }
}
