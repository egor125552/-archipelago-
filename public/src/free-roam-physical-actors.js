"use strict";

const PLAYER_RADIUS = 1.4;
const BOAT_RADIUS = 6;
const PURSUER_RADIUS = 6.8;
const NEARBY_DISTANCE = 12;
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

function emit(world, type, text, targets, extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function ensurePhysicalState(world) {
  world.freePhysical ||= {
    nearPlayers: Array.from({length: world.players.length}, () => false),
    playerContactAt: -999,
    boatContactAt: Array.from({length: world.players.length}, () => -999),
    boatBlocked: Array.from({length: world.players.length}, () => false),
  };
  while (world.freePhysical.nearPlayers.length < world.players.length) world.freePhysical.nearPlayers.push(false);
  while (world.freePhysical.boatContactAt.length < world.players.length) world.freePhysical.boatContactAt.push(-999);
  world.freePhysical.boatBlocked ||= Array.from({length: world.players.length}, () => false);
  while (world.freePhysical.boatBlocked.length < world.players.length) world.freePhysical.boatBlocked.push(false);
  return world.freePhysical;
}

function isPhysicalPlayer(world, index) {
  const player = world.players[index];
  return Boolean(
    world.freeActivities?.presence?.[index]
    && player?.combat?.alive
    && ["foot", "swim"].includes(player.mode),
  );
}

function separatePointFromBody(point, body, minimum, fallbackX = 1) {
  let dx = point.x - body.x;
  let dy = point.y - body.y;
  let metres = Math.hypot(dx, dy);
  if (metres >= minimum) return false;
  if (metres < 0.001) {
    dx = fallbackX;
    dy = 0;
    metres = 1;
  }
  const push = minimum - metres;
  point.x += dx / metres * push;
  point.y += dy / metres * push;
  return true;
}

function resolvePlayerPair(world, state) {
  if (!isPhysicalPlayer(world, 0) || !isPhysicalPlayer(world, 1)) {
    state.nearPlayers[0] = false;
    state.nearPlayers[1] = false;
    return;
  }
  const first = world.players[0];
  const second = world.players[1];
  let dx = second.x - first.x;
  let dy = second.y - first.y;
  let metres = Math.hypot(dx, dy);
  const nearby = metres <= NEARBY_DISTANCE;
  for (let index = 0; index < 2; index += 1) {
    if (nearby && !state.nearPlayers[index]) {
      const other = 1 - index;
      emit(world, "player-nearby", `Рядом живой игрок, ${Math.max(1, Math.round(metres))} метров.`, [index], {
        sourcePlayer: other,
        targetPlayer: index,
        x: world.players[other].x,
        y: world.players[other].y,
      });
    }
    state.nearPlayers[index] = nearby;
  }
  const minimum = PLAYER_RADIUS * 2;
  if (metres >= minimum) return;
  if (metres < 0.001) {
    dx = 1;
    dy = 0;
    metres = 1;
  }
  const overlap = minimum - metres;
  const nx = dx / metres;
  const ny = dy / metres;
  first.x -= nx * overlap * 0.5;
  first.y -= ny * overlap * 0.5;
  second.x += nx * overlap * 0.5;
  second.y += ny * overlap * 0.5;
  if (world.time - state.playerContactAt >= 0.8) {
    state.playerContactAt = world.time;
    emit(world, "player-contact", "Перед тобой игрок. Сквозь него не пройти.", [0, 1], {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    });
  }
}

function resolvePlayersAgainstBoats(world, state) {
  for (let index = 0; index < world.players.length; index += 1) {
    if (!isPhysicalPlayer(world, index)) continue;
    const player = world.players[index];
    for (const boat of world.boats || []) {
      if (!boat || boat.sunk) continue;
      if (!separatePointFromBody(player, boat, PLAYER_RADIUS + BOAT_RADIUS, index ? 1 : -1)) continue;
      state.boatBlocked[index] = true;
      boat.speed *= 0.35;
      if (world.time - state.boatContactAt[index] >= 0.9) {
        state.boatContactAt[index] = world.time;
        emit(world, "boat-body-contact", "Ты дошёл до борта катера. Дальше корпус; шаги остановлены.", [index], {
          sourcePlayer: boat.driver ?? boat.owner,
          x: boat.x,
          y: boat.y,
        });
      }
    }
    const pursuer = world.freeActivities?.marauder;
    if (pursuer?.active && !pursuer.destroyed) {
      separatePointFromBody(player, pursuer, PLAYER_RADIUS + PURSUER_RADIUS, index ? 1 : -1);
    }
    for (const escort of world.freePursuerSquad?.escorts || []) {
      if (!escort.active || escort.destroyed) continue;
      separatePointFromBody(player, escort, PLAYER_RADIUS + PURSUER_RADIUS, index ? 1 : -1);
    }
  }
}

export function updatePhysicalActors(world) {
  const state = ensurePhysicalState(world);
  state.boatBlocked.fill(false);
  resolvePlayerPair(world, state);
  resolvePlayersAgainstBoats(world, state);
  return state;
}

export function suppressIncapacitatedMovement(world) {
  const restored = [];
  for (let index = 0; index < (world.players?.length || 0); index += 1) {
    const combat = world.players[index]?.combat;
    const input = world.inputs?.[index];
    if (!combat?.knockedDown || !input) continue;
    const values = {
      up: input.up,
      down: input.down,
      left: input.left,
      right: input.right,
      jump: input.jump,
      action: input.action,
    };
    Object.assign(input, {up: false, down: false, left: false, right: false, jump: false, action: false});
    restored.push([input, values]);
  }
  return () => {
    for (const [input, values] of restored) Object.assign(input, values);
  };
}
