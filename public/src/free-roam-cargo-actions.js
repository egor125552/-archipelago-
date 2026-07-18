"use strict";

const DOCK_MIN_X = 154;
const DOCK_MAX_X = 266;
const DOCK_FOOT_Y = 76;
const THEFT_NOTICE_DISTANCE = 14;
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

export function deliverCarriedCargoAtDock(world, playerIndex, crate, rewardPlayer, emit) {
  const player = world.players[playerIndex];
  const atDock = player
    && ["foot", "swim"].includes(player.mode)
    && player.x >= DOCK_MIN_X
    && player.x <= DOCK_MAX_X
    && player.y <= DOCK_FOOT_Y;
  if (!atDock || !crate) return false;
  const boat = world.boats.find(candidate => candidate.owner === playerIndex) || world.boats[0];
  rewardPlayer(world, playerIndex, boat, crate);
  player.combat.carriedCrate = null;
  crate.state = "delivered";
  crate.carriedBy = null;
  crate.stowedBoat = null;
  crate.respawnAt = world.time + 12;
  emit(world, "cargo-delivered", "Ты вручную сдал ящик на причале.", [0, 1], {
    sourcePlayer: playerIndex,
    count: 1,
    score: world.freeActivities.score[playerIndex],
    kinds: [crate.kind],
    x: player.x,
    y: player.y,
  });
  return true;
}

export function updateCargoActionPrompts(world, emit) {
  world.freeCargoActions ||= {
    theftReady: Array.from({length: world.players.length}, () => false),
  };
  const state = world.freeCargoActions;
  while (state.theftReady.length < world.players.length) state.theftReady.push(false);

  for (let index = 0; index < world.players.length; index += 1) {
    const player = world.players[index];
    let targetBoat = null;
    let best = THEFT_NOTICE_DISTANCE;
    if (
      world.freeActivities.presence[index]
      && player?.combat?.alive
      && !player.combat.carriedCrate
      && ["foot", "swim"].includes(player.mode)
    ) {
      for (const boat of world.boats || []) {
        if (boat.sunk || boat.owner === index || boat.driver === index || !(boat.cargo || []).length) continue;
        const metres = distance(player, boat);
        if (metres < best) {
          best = metres;
          targetBoat = boat;
        }
      }
    }
    const ready = Boolean(targetBoat);
    if (ready && !state.theftReady[index]) {
      emit(
        world,
        "cargo-theft-ready",
        best <= 8.5
          ? "Чужая лодка с грузом рядом. Нажми F, чтобы украсть один ящик."
          : `Чужая лодка с грузом в ${Math.round(best)} метрах. Подойди к борту и нажми F, чтобы украсть ящик.`,
        [index],
        {sourcePlayer: targetBoat.driver ?? targetBoat.owner, x: targetBoat.x, y: targetBoat.y},
      );
    }
    state.theftReady[index] = ready;
  }
}
