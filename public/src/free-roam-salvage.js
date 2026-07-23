"use strict";

const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

export function extractionHelpers(world, playerIndex, crate) {
  if (!crate || crate.state !== "world" || crate.contractCategory !== "salvage") return 0;
  let helpers = 0;
  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (index === playerIndex || !world.freeActivities?.presence?.[index]) continue;
    const player = world.players[index];
    if (player?.combat?.alive && ["foot", "swim"].includes(player.mode) && distance(player, crate) <= 7) helpers += 1;
  }
  return helpers;
}

export function updateSalvageExtraction(world, dt, emit) {
  const contracts = world.freeContracts;
  const active = contracts?.activeContract;
  if (!active || active.category !== "salvage" || !active.crateId) return;
  const crate = world.freeActivities?.crates?.find(candidate => candidate.id === active.crateId);
  if (!crate || crate.state !== "world" || crate.extracted) return;
  for (let index = 0; index < world.players.length; index += 1) {
    const input = world.freeActivities.inputs?.[index] || {};
    const player = world.players[index];
    if (!world.freeActivities.presence?.[index] || !player?.combat?.alive || !input.action) continue;
    if (!["foot", "swim"].includes(player.mode) || distance(player, crate) > 4.5) continue;
    const helperCount = extractionHelpers(world, index, crate);
    crate.extractionProgress = Math.max(0, (Number(crate.extractionProgress) || 0) + dt * (1 + helperCount * 0.65));
    active.phase = "extract";
    if (!crate.extractionAnnounced) {
      crate.extractionAnnounced = true;
      emit(world, "salvage-extraction-start", `Начинаю демонтаж: ${crate.label}. Удерживай действие.`, [index], {crateId: crate.id, sourcePlayer: index, x: crate.x, y: crate.y});
    }
    if (crate.extractionProgress + 0.001 < (Number(crate.extractionSeconds) || 3)) continue;
    crate.extracted = true;
    crate.extractionProgress = crate.extractionSeconds;
    active.phase = "transport";
    emit(world, "salvage-extracted", `${crate.label} отделён от обломков. Теперь его можно поднять и погрузить.`, [0, 1], {crateId: crate.id, sourcePlayer: index, x: crate.x, y: crate.y});
  }
}
