"use strict";

export const WORLD = Object.freeze({
  width: 420,
  height: 320,
  shoreY: 72,
  dockMinX: 154,
  dockMaxX: 266,
  boatRadius: 6,
  towLength: 18,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rad = degrees => degrees * Math.PI / 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const normalizedAngle = angle => ((angle + 540) % 360) - 180;
const copyInput = input => ({
  up: Boolean(input?.up),
  down: Boolean(input?.down),
  left: Boolean(input?.left),
  right: Boolean(input?.right),
  pump: Boolean(input?.pump),
  repair: Boolean(input?.repair),
  action: Boolean(input?.action),
  jump: Boolean(input?.jump),
});

function boat(id, x, y, heading, owner) {
  return {
    id,
    owner,
    driver: owner,
    x,
    y,
    heading,
    speed: 0,
    hull: 100,
    water: 0,
    leak: 0,
    sunk: false,
    anchor: false,
    collisionCooldown: 0,
  };
}

function player(id, activeBoat) {
  return {
    id,
    mode: "boat",
    activeBoat,
    x: 0,
    y: 0,
    heading: 0,
    jumpTimer: 0,
    stepTimer: 0,
  };
}

export function createFreeWorld() {
  return {
    version: 1,
    time: 0,
    boats: [
      boat(0, 165, 158, 0, 0),
      boat(1, 255, 158, 180, 1),
    ],
    players: [player(0, 0), player(1, 1)],
    inputs: [copyInput(), copyInput()],
    previousInputs: [copyInput(), copyInput()],
    tow: null,
    events: [],
  };
}

export function setPlayerInput(world, playerIndex, nextInput) {
  if (!world?.inputs?.[playerIndex]) return;
  world.inputs[playerIndex] = copyInput(nextInput);
}

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events.push({type, text, targets, at: world.time, ...extra});
  if (world.events.length > 80) world.events.splice(0, world.events.length - 80);
}

export function drainEvents(world) {
  const events = world.events.splice(0);
  return events;
}

function nearDock(boatState) {
  return boatState.y <= WORLD.shoreY + 18
    && boatState.x >= WORLD.dockMinX
    && boatState.x <= WORLD.dockMaxX;
}

function nearestBoat(world, point, excluded = -1) {
  let result = null;
  let best = Infinity;
  for (const candidate of world.boats) {
    if (candidate.id === excluded) continue;
    const d = distance(candidate, point);
    if (d < best) {
      best = d;
      result = candidate;
    }
  }
  return {boat: result, distance: best};
}

function exitBoat(world, playerIndex, boatState) {
  const p = world.players[playerIndex];
  boatState.driver = null;
  p.activeBoat = null;
  p.mode = nearDock(boatState) ? "foot" : "swim";
  p.x = boatState.x;
  p.y = nearDock(boatState) ? WORLD.shoreY - 7 : boatState.y + 8;
  p.heading = boatState.heading;
  emit(world, "exit", p.mode === "foot" ? "Ты вышел на берег." : "Ты спрыгнул в воду.", [playerIndex]);
}

function enterBoat(world, playerIndex, targetBoat) {
  const p = world.players[playerIndex];
  if (targetBoat.driver != null || targetBoat.sunk) return false;
  targetBoat.driver = playerIndex;
  p.mode = "boat";
  p.activeBoat = targetBoat.id;
  p.x = targetBoat.x;
  p.y = targetBoat.y;
  emit(world, "enter", targetBoat.owner === playerIndex ? "Ты вернулся в свою лодку." : "Ты угнал чужую лодку.", [playerIndex]);
  return true;
}

function climbRoof(world, playerIndex, targetBoat) {
  const p = world.players[playerIndex];
  p.mode = "roof";
  p.activeBoat = targetBoat.id;
  p.x = targetBoat.x;
  p.y = targetBoat.y;
  emit(world, "roof", "Ты запрыгнул на крышу лодки.", [playerIndex]);
}

function detachTow(world, text = "Буксировочный трос отцеплен.") {
  if (!world.tow) return;
  emit(world, "tow-detach", text, [0, 1]);
  world.tow = null;
}

function attachTow(world, towerBoat, towedBoat, playerIndex) {
  if (towerBoat.sunk || towedBoat.sunk) return;
  world.tow = {
    towerBoat: towerBoat.id,
    towedBoat: towedBoat.id,
    tension: 0,
    strainTime: 0,
  };
  emit(world, "tow-attach", "Буксировочный трос закреплён. Можно ехать; второй игрок может чиниться на ходу.", [0, 1], {by: playerIndex});
}

function processAction(world, playerIndex) {
  const p = world.players[playerIndex];
  if (p.mode === "boat") {
    const ownBoat = world.boats[p.activeBoat];
    if (!ownBoat) return;
    if (nearDock(ownBoat) && Math.abs(ownBoat.speed) < 1.6) {
      exitBoat(world, playerIndex, ownBoat);
      return;
    }
    if (world.tow?.towerBoat === ownBoat.id) {
      detachTow(world);
      return;
    }
    const nearest = nearestBoat(world, ownBoat, ownBoat.id);
    if (nearest.boat && nearest.distance <= 24 && Math.abs(ownBoat.speed) < 3.2 && Math.abs(nearest.boat.speed) < 3.2) {
      attachTow(world, ownBoat, nearest.boat, playerIndex);
      return;
    }
    emit(world, "action-denied", "Для действия F подойди к берегу или к другой лодке и сбрось скорость.", [playerIndex]);
    return;
  }

  if (p.mode === "roof") {
    const targetBoat = world.boats[p.activeBoat];
    if (targetBoat && enterBoat(world, playerIndex, targetBoat)) return;
    emit(world, "action-denied", "Место занято. Пробел — спрыгнуть с крыши.", [playerIndex]);
    return;
  }

  const nearest = nearestBoat(world, p);
  if (nearest.boat && nearest.distance <= 12 && enterBoat(world, playerIndex, nearest.boat)) return;
  if (p.mode === "swim" && p.y <= WORLD.shoreY + 5) {
    p.mode = "foot";
    p.y = WORLD.shoreY - 4;
    emit(world, "shore", "Ты выбрался на берег.", [playerIndex]);
    return;
  }
  emit(world, "action-denied", "Рядом нет свободной лодки или берега.", [playerIndex]);
}

function processJump(world, playerIndex) {
  const p = world.players[playerIndex];
  if (p.mode === "roof") {
    const b = world.boats[p.activeBoat];
    p.mode = b && b.y <= WORLD.shoreY + 20 ? "foot" : "swim";
    p.activeBoat = null;
    p.x = (b?.x || p.x) + 7;
    p.y = p.mode === "foot" ? WORLD.shoreY - 5 : (b?.y || p.y) + 8;
    emit(world, "jump", p.mode === "foot" ? "Ты спрыгнул с крыши на берег." : "Ты спрыгнул с крыши в воду.", [playerIndex]);
    return;
  }
  if (p.mode === "foot" || p.mode === "swim") {
    const nearest = nearestBoat(world, p);
    if (nearest.boat && nearest.distance <= 10 && !nearest.boat.sunk) {
      climbRoof(world, playerIndex, nearest.boat);
      return;
    }
    if (p.mode === "foot") {
      p.jumpTimer = 0.45;
      emit(world, "jump", "Прыжок.", [playerIndex]);
    }
  }
}

function updatePlayerOnFoot(world, playerIndex, dt) {
  const p = world.players[playerIndex];
  const input = world.inputs[playerIndex];
  if (p.mode === "roof") {
    const b = world.boats[p.activeBoat];
    if (!b || b.sunk) {
      p.mode = "swim";
      p.activeBoat = null;
      emit(world, "splash", "Лодка ушла под воду. Ты оказался в воде.", [playerIndex]);
      return;
    }
    p.x = b.x;
    p.y = b.y;
    p.heading = b.heading;
    return;
  }
  if (p.mode !== "foot" && p.mode !== "swim") return;

  let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;
  const moving = Math.abs(dx) + Math.abs(dy) > 0;
  const speed = p.mode === "swim" ? 15 : 24;
  p.x = clamp(p.x + dx * speed * dt, 5, WORLD.width - 5);
  p.y = clamp(p.y + dy * speed * dt, 5, WORLD.height - 5);
  if (moving) p.heading = Math.atan2(dx, -dy) * 180 / Math.PI;

  if (p.mode === "foot" && p.y > WORLD.shoreY + 3) {
    p.mode = "swim";
    emit(world, "splash", "Ты вошёл в воду.", [playerIndex]);
  } else if (p.mode === "swim" && p.y < WORLD.shoreY - 2) {
    p.mode = "foot";
    emit(world, "shore", "Ты вышел из воды на берег.", [playerIndex]);
  }

  p.stepTimer -= dt;
  if (moving && p.stepTimer <= 0) {
    p.stepTimer = p.mode === "swim" ? 0.62 : 0.42;
    emit(world, p.mode === "swim" ? "swim-step" : "footstep", "", [playerIndex]);
  }
  p.jumpTimer = Math.max(0, p.jumpTimer - dt);
}

function updateBoat(world, boatState, dt) {
  boatState.collisionCooldown = Math.max(0, boatState.collisionCooldown - dt);
  if (boatState.sunk) return;
  const driver = boatState.driver;
  const input = driver == null ? null : world.inputs[driver];
  let throttle = 0;
  if (input?.up) throttle += 1;
  if (input?.down) throttle -= 1;

  if (boatState.anchor) {
    boatState.speed *= Math.exp(-5.5 * dt);
  } else {
    const acceleration = throttle > 0 ? 8.2 : throttle < 0 ? -10.5 : 0;
    boatState.speed += acceleration * dt;
    boatState.speed *= Math.exp(-(throttle ? 0.36 : 0.72) * dt);
    boatState.speed = clamp(boatState.speed, -5.5, 15);
  }

  const steering = (input?.right ? 1 : 0) - (input?.left ? 1 : 0);
  const turnStrength = 55 * clamp(Math.abs(boatState.speed) / 4, 0.22, 1.5);
  boatState.heading = (boatState.heading + steering * turnStrength * dt * (boatState.speed < 0 ? -1 : 1) + 360) % 360;
  boatState.x += Math.sin(rad(boatState.heading)) * boatState.speed * dt;
  boatState.y -= Math.cos(rad(boatState.heading)) * boatState.speed * dt;

  boatState.x = clamp(boatState.x, WORLD.boatRadius, WORLD.width - WORLD.boatRadius);
  boatState.y = clamp(boatState.y, WORLD.shoreY + 4, WORLD.height - WORLD.boatRadius);

  if (boatState.y <= WORLD.shoreY + 5 && !nearDock(boatState)) {
    const impact = Math.abs(boatState.speed);
    boatState.y = WORLD.shoreY + 6;
    if (impact > 2.5 && boatState.collisionCooldown <= 0) {
      boatState.hull = clamp(boatState.hull - impact * 1.8, 0, 100);
      boatState.leak = clamp(boatState.leak + impact * 0.08, 0, 2.5);
      boatState.collisionCooldown = 0.8;
      emit(world, "collision", "Удар о берег.", [driver ?? boatState.owner], {strength: impact});
    }
    boatState.speed = Math.max(0, -boatState.speed * 0.28);
  }

  boatState.water = clamp(boatState.water + boatState.leak * dt, 0, 100);
  if (input?.pump) boatState.water = clamp(boatState.water - 9 * dt, 0, 100);
  if (input?.repair && (Math.abs(boatState.speed) < 1.8 || world.tow?.towedBoat === boatState.id)) {
    boatState.hull = clamp(boatState.hull + 3.2 * dt, 0, 100);
    boatState.leak = clamp(boatState.leak - 0.13 * dt, 0, 2.5);
  }

  if (boatState.hull <= 0 || boatState.water >= 100) {
    boatState.sunk = true;
    boatState.speed = 0;
    if (world.tow?.towerBoat === boatState.id || world.tow?.towedBoat === boatState.id) detachTow(world, "Трос сорван: одна из лодок затонула.");
    if (driver != null) {
      const p = world.players[driver];
      p.mode = "swim";
      p.activeBoat = null;
      p.x = boatState.x;
      p.y = boatState.y;
      boatState.driver = null;
      emit(world, "sink", "Лодка затонула. Ты в воде; плыви к берегу или к свободной лодке.", [driver]);
    }
  }
}

function resolveBoatCollision(world) {
  const a = world.boats[0];
  const b = world.boats[1];
  if (a.sunk || b.sunk) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const minDistance = WORLD.boatRadius * 2;
  if (d >= minDistance || d <= 0.001) return;
  const nx = dx / d;
  const ny = dy / d;
  const overlap = minDistance - d;
  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;

  const relative = Math.abs(a.speed - b.speed) + Math.abs(a.speed) * 0.35 + Math.abs(b.speed) * 0.35;
  if (relative > 2 && a.collisionCooldown <= 0 && b.collisionCooldown <= 0) {
    const damage = Math.pow(relative, 1.35) * 0.55;
    a.hull = clamp(a.hull - damage, 0, 100);
    b.hull = clamp(b.hull - damage, 0, 100);
    a.leak = clamp(a.leak + damage * 0.018, 0, 2.5);
    b.leak = clamp(b.leak + damage * 0.018, 0, 2.5);
    a.speed *= -0.26;
    b.speed *= -0.26;
    a.collisionCooldown = 0.9;
    b.collisionCooldown = 0.9;
    emit(world, "ram", `Столкновение лодок. Урон ${Math.round(damage)}.`, [0, 1], {strength: relative});
  }
}

function updateTow(world, dt) {
  const tow = world.tow;
  if (!tow) return;
  const tower = world.boats[tow.towerBoat];
  const towed = world.boats[tow.towedBoat];
  if (!tower || !towed || tower.sunk || towed.sunk) {
    detachTow(world, "Буксировочный трос отцепился.");
    return;
  }
  const dx = tower.x - towed.x;
  const dy = tower.y - towed.y;
  const d = Math.hypot(dx, dy) || 0.001;
  const excess = Math.max(0, d - WORLD.towLength);
  const nx = dx / d;
  const ny = dy / d;
  if (excess > 0) {
    const pull = Math.min(excess * 0.62, 6) * dt;
    towed.x += nx * pull;
    towed.y += ny * pull;
    towed.speed += tower.speed * 0.42 * dt;
    tower.speed *= 1 - Math.min(0.2, excess * 0.006);
  }

  let opposition = 0;
  const driver = towed.driver;
  if (driver != null && world.inputs[driver]?.up) {
    const desiredHeading = Math.atan2(nx, -ny) * 180 / Math.PI;
    const error = Math.abs(normalizedAngle(towed.heading - desiredHeading));
    if (error <= 55) {
      tow.tension = Math.max(0, tow.tension - 0.8 * dt);
      towed.speed += Math.max(0, tower.speed) * 0.18 * dt;
    } else {
      opposition = clamp((error - 55) / 100, 0, 1);
    }
  }
  tow.tension = clamp(tow.tension + (excess / 10 + opposition * 0.9) * dt - 0.35 * dt, 0, 1.5);
  if (tow.tension > 0.92) tow.strainTime += dt;
  else tow.strainTime = Math.max(0, tow.strainTime - dt * 1.4);

  if (tow.strainTime > 2.1 || d > WORLD.towLength * 2.2) {
    detachTow(world, "Трос лопнул: ведомая лодка тянула в сторону. Чтобы помогать, держи нос по направлению буксира.");
  } else if (tow.tension > 0.72 && Math.floor(world.time * 2) !== Math.floor((world.time - dt) * 2)) {
    emit(world, "tow-strain", "Трос сильно натянут.", [0, 1], {tension: tow.tension});
  }
}

export function stepFreeWorld(world, dt) {
  const safeDt = clamp(Number(dt) || 0, 0, 0.1);
  world.time += safeDt;

  for (let i = 0; i < world.players.length; i += 1) {
    const input = world.inputs[i];
    const previous = world.previousInputs[i];
    if (input.action && !previous.action) processAction(world, i);
    if (input.jump && !previous.jump) processJump(world, i);
  }

  for (const b of world.boats) updateBoat(world, b, safeDt);
  resolveBoatCollision(world);
  updateTow(world, safeDt);
  for (let i = 0; i < world.players.length; i += 1) updatePlayerOnFoot(world, i, safeDt);

  for (let i = 0; i < world.players.length; i += 1) {
    const p = world.players[i];
    if (p.mode === "boat") {
      const b = world.boats[p.activeBoat];
      if (b) {
        p.x = b.x;
        p.y = b.y;
        p.heading = b.heading;
      }
    }
    world.previousInputs[i] = copyInput(world.inputs[i]);
  }
  return world;
}

export function playerStatus(world, playerIndex) {
  const p = world.players[playerIndex];
  const other = world.players[1 - playerIndex];
  const modeLabel = p.mode === "boat" ? "в лодке" : p.mode === "foot" ? "на берегу" : p.mode === "roof" ? "на крыше лодки" : "в воде";
  const parts = [`Ты ${modeLabel}.`];
  if (p.mode === "boat") {
    const b = world.boats[p.activeBoat];
    parts.push(`Скорость ${Math.abs(b.speed).toFixed(1)}. Корпус ${Math.round(b.hull)}. Вода ${Math.round(b.water)}.`);
    if (world.tow?.towerBoat === b.id) parts.push("Ты буксируешь вторую лодку.");
    if (world.tow?.towedBoat === b.id) parts.push("Тебя буксируют; насос и ремонт работают на ходу.");
  }
  parts.push(`Другой игрок в ${Math.round(distance(p, other))} метрах.`);
  return parts.join(" ");
}

export function snapshotWorld(world) {
  return JSON.parse(JSON.stringify({...world, events: []}));
}
