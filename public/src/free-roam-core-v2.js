"use strict";

import {CONFIG} from "./game-core-v18.js?free=2";
import {applyCollisionDamage, collisionSeverity} from "./collision-model.js";
import {unattendedLeakMultiplier} from "./free-roam-unattended-boat.js";

export const WORLD = Object.freeze({
  width: 420,
  height: 320,
  shoreY: 72,
  shoreAccessMinX: 118,
  shoreAccessMaxX: 302,
  dockMinX: 154,
  dockMaxX: 266,
  boatRadius: 6,
  towLength: 18,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rad = degrees => degrees * Math.PI / 180;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
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
    throttle: 0,
    rudder: 0,
    hull: 100,
    armor: 0,
    armorMax: 0,
    water: 0,
    leak: 0,
    fuel: 100,
    engineTemp: 24,
    engineStalled: false,
    pumpActive: false,
    repairPatches: 3,
    hullRepairProgress: 0,
    repairQuarter: 0,
    emergencyActive: false,
    emergencyRemaining: CONFIG.floodEmergencySeconds || 45,
    emergencyWarned15: false,
    emergencyWarned5: false,
    restartProgress: 0,
    sunk: false,
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
    version: 2,
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
  if (world.events.length > 100) world.events.splice(0, world.events.length - 100);
}

export function drainEvents(world) {
  return world.events.splice(0);
}

function targetsForBoat(boatState) {
  return [boatState.driver ?? boatState.owner];
}

function nearShoreLanding(boatState) {
  return boatState.y <= WORLD.shoreY + 18
    && boatState.x >= WORLD.shoreAccessMinX
    && boatState.x <= WORLD.shoreAccessMaxX;
}

function nearestBoat(world, point, excluded = -1) {
  let result = null;
  let best = Infinity;
  for (const candidate of world.boats) {
    if (candidate.id === excluded) continue;
    const metres = distance(candidate, point);
    if (metres < best) {
      best = metres;
      result = candidate;
    }
  }
  return {boat: result, distance: best};
}

function exitBoat(world, playerIndex, boatState) {
  const p = world.players[playerIndex];
  const landsOnShore = nearShoreLanding(boatState);
  boatState.driver = null;
  boatState.throttle = 0;
  boatState.rudder = 0;
  p.activeBoat = null;
  p.mode = landsOnShore ? "foot" : "swim";
  p.x = boatState.x;
  p.y = landsOnShore ? WORLD.shoreY - 7 : boatState.y + 8;
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
  emit(world, "tow-attach", "Буксировочный трос закреплён. Можно ехать; второй игрок может откачивать воду и ставить пластину на ходу.", [0, 1], {by: playerIndex});
}

function processAction(world, playerIndex) {
  const p = world.players[playerIndex];
  if (p.mode === "boat") {
    const ownBoat = world.boats[p.activeBoat];
    if (!ownBoat) return;
    if (nearShoreLanding(ownBoat) && Math.abs(ownBoat.speed) < 1.6) {
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
    emit(world, "action-denied", "Для высадки подойди к береговой площадке и полностью сбрось скорость.", [playerIndex]);
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
  const movementSpeed = p.mode === "swim" ? 6 : 8;
  p.x = clamp(p.x + dx * movementSpeed * dt, 5, WORLD.width - 5);
  p.y = clamp(p.y + dy * movementSpeed * dt, 5, WORLD.height - 5);
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

function startEmergency(world, boatState, cause) {
  if (boatState.emergencyActive || boatState.sunk) return;
  boatState.emergencyActive = true;
  boatState.emergencyRemaining = CONFIG.floodEmergencySeconds || 45;
  boatState.emergencyWarned15 = false;
  boatState.emergencyWarned5 = false;
  boatState.engineStalled = true;
  boatState.throttle = 0;
  boatState.rudder = 0;
  boatState.speed = 0;
  if (cause === "flooded") boatState.water = 100;
  if (boatState.hull <= 0) boatState.hull = 0.05;
  emit(world, "flood-emergency-start", `Авария. Есть ${Math.round(boatState.emergencyRemaining)} секунд: пластина и насос. Буксир остаётся доступен.`, targetsForBoat(boatState), {cause});
}

function sinkBoat(world, boatState) {
  boatState.sunk = true;
  boatState.emergencyActive = false;
  boatState.speed = 0;
  boatState.throttle = 0;
  if (world.tow?.towerBoat === boatState.id || world.tow?.towedBoat === boatState.id) detachTow(world, "Трос сорван: одна из лодок затонула.");
  const driver = boatState.driver;
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

function updateEmergency(world, boatState, dt) {
  if (!boatState.emergencyActive) return;
  boatState.engineStalled = true;
  boatState.throttle = 0;
  boatState.speed *= Math.exp(-3.2 * dt);
  if (Math.abs(boatState.speed) < 0.12) boatState.speed = 0;

  const recovered = boatState.water <= (CONFIG.floodRecoveryWater || 35)
    && boatState.hull >= (CONFIG.floodRecoveryHull || 5);
  if (recovered) {
    boatState.emergencyActive = false;
    boatState.emergencyRemaining = 0;
    boatState.restartProgress = 0;
    emit(world, "flood-emergency-recovered", "Лодка стабилизирована. Мотор запускается после осушения.", targetsForBoat(boatState));
    return;
  }

  boatState.emergencyRemaining -= dt;
  if (boatState.emergencyRemaining <= 0) {
    emit(world, "flood-emergency-failed", "Аварийное время вышло.", targetsForBoat(boatState));
    sinkBoat(world, boatState);
    return;
  }
  if (boatState.emergencyRemaining <= 5 && !boatState.emergencyWarned5) {
    boatState.emergencyWarned5 = true;
    emit(world, "flood-emergency-warning", "Пять секунд. Пластина и насос немедленно.", targetsForBoat(boatState), {critical: true});
  } else if (boatState.emergencyRemaining <= 15 && !boatState.emergencyWarned15) {
    boatState.emergencyWarned15 = true;
    emit(world, "flood-emergency-warning", "Пятнадцать секунд аварийного времени.", targetsForBoat(boatState), {critical: false});
  }
}

function processHullRepair(world, boatState, input, dt) {
  if (!input?.repair || boatState.sunk) {
    boatState.hullRepairProgress = 0;
    boatState.repairQuarter = 0;
    return;
  }
  const targets = targetsForBoat(boatState);
  const towed = world.tow?.towedBoat === boatState.id;
  if (boatState.repairPatches <= 0) {
    emit(world, "repair-blocked", "Ремонтные пластины закончились.", targets);
    boatState.hullRepairProgress = 0;
    return;
  }
  if (boatState.leak <= 0.05 && boatState.hull >= 99) return;
  if (Math.abs(boatState.speed) > (CONFIG.hullRepairSpeedLimit || 1.8) && !towed) {
    boatState.hullRepairProgress = Math.max(0, boatState.hullRepairProgress - dt * 0.7);
    return;
  }

  boatState.hullRepairProgress += dt;
  const duration = CONFIG.hullRepairDuration || 3.1;
  const quarter = Math.min(4, Math.floor(boatState.hullRepairProgress / duration * 4));
  if (quarter > boatState.repairQuarter && quarter < 4) {
    boatState.repairQuarter = quarter;
    emit(world, "hull-repair-progress", `Заделка пробоины: ${quarter * 25} процентов.`, targets, {percent: quarter * 25});
  }
  if (boatState.hullRepairProgress < duration) return;

  boatState.hull = clamp(boatState.hull + (CONFIG.hullRepairAmount || 22), 0, 100);
  boatState.leak = clamp(boatState.leak - (CONFIG.leakRepairAmount || 3.2), 0, 16);
  boatState.repairPatches -= 1;
  boatState.hullRepairProgress = 0;
  boatState.repairQuarter = 0;
  emit(world, "hull-repair-complete", `Пластина закреплена. Корпус ${Math.round(boatState.hull)} процентов. Пластин осталось ${boatState.repairPatches}.`, targets);
}

function updateBoat(world, boatState, dt) {
  boatState.collisionCooldown = Math.max(0, boatState.collisionCooldown - dt);
  if (boatState.sunk) return;
  if (boatState.boundaryContact === "shore" && boatState.y > WORLD.shoreY + 7.2) {
    boatState.boundaryContact = null;
  }
  const driver = boatState.driver;
  const input = driver == null ? copyInput() : world.inputs[driver];
  const previous = driver == null ? copyInput() : world.previousInputs[driver];
  const targets = targetsForBoat(boatState);

  if (input.pump && !previous.pump) emit(world, "pump-start", "Насос включён.", targets);
  if (input.repair && !previous.repair) emit(world, "hull-repair-start", "Заделка пробоины началась.", targets);

  const steer = Number(input.right) - Number(input.left);
  let thrust = Number(input.up) - Number(input.down);
  if (thrust && boundaryBlocksThrust(boatState, thrust)) thrust = 0;
  boatState.rudder += (steer - boatState.rudder) * Math.min(1, dt * 7);
  boatState.throttle += (thrust - boatState.throttle) * Math.min(1, dt * 4.5);
  if (boatState.engineStalled || boatState.emergencyActive) boatState.throttle = 0;

  const targetSpeed = boatState.throttle >= 0
    ? boatState.throttle * CONFIG.maxSpeed
    : boatState.throttle * Math.abs(CONFIG.reverseSpeed);
  boatState.speed += clamp(targetSpeed - boatState.speed, -CONFIG.acceleration * dt, CONFIG.acceleration * dt);
  boatState.speed *= Math.max(0, 1 - CONFIG.drag * dt * (0.12 + Math.abs(boatState.speed) / CONFIG.maxSpeed * 0.16));
  const turnFactor = clamp(Math.abs(boatState.speed) / 4.5, 0.18, 1.25);
  boatState.heading = wrapDeg(boatState.heading + boatState.rudder * CONFIG.turnRate * turnFactor * dt * 60 * Math.sign(boatState.speed || 1));
  boatState.x += Math.sin(rad(boatState.heading)) * boatState.speed * dt;
  boatState.y -= Math.cos(rad(boatState.heading)) * boatState.speed * dt;

  boatState.x = clamp(boatState.x, WORLD.boatRadius, WORLD.width - WORLD.boatRadius);
  boatState.y = clamp(boatState.y, WORLD.shoreY + 4, WORLD.height - WORLD.boatRadius);

  if (boatState.y <= WORLD.shoreY + 5) {
    const impactSpeed = Math.abs(boatState.speed);
    const firstContact = boatState.boundaryContact !== "shore";
    boatState.boundaryContact = "shore";
    boatState.y = WORLD.shoreY + 6;
    if (impactSpeed > (CONFIG.shoreScrapeSpeed || 1.25) && boatState.collisionCooldown <= 0) {
      const severity = collisionSeverity(impactSpeed);
      const hard = impactSpeed >= (CONFIG.shoreHardImpactSpeed || 5);
      const ramp = clamp((impactSpeed - (CONFIG.shoreScrapeSpeed || 1.25)) / ((CONFIG.shoreHardImpactSpeed || 5) - (CONFIG.shoreScrapeSpeed || 1.25)), 0, 1);
      const rawDamage = ((CONFIG.shoreBaseDamage || 6) + (CONFIG.shoreSeverityDamage || 15) * severity) * ramp;
      const impact = applyCollisionDamage(boatState, rawDamage);
      boatState.leak = clamp(boatState.leak + impact.damage * 0.08, 0, 16);
      boatState.collisionCooldown = CONFIG.shoreImpactCooldown || 1.35;
      emit(world, "collision", hard ? "Сильный удар о берег." : "Удар о берег.", targets, {strength: impactSpeed, damage: impact.damage, shore: true});
    } else if (firstContact) {
      emit(world, "collision", "Лодка упёрлась в берег и остановилась.", targets, {
        strength: impactSpeed,
        damage: 0,
        shore: true,
        scrape: true,
      });
    }
    boatState.speed = impactSpeed <= (CONFIG.shoreScrapeSpeed || 1.25) ? 0 : -Math.sign(boatState.speed || 1) * Math.min(impactSpeed, Math.max(0.35, impactSpeed * 0.35));
    boatState.throttle = 0;
  }

  const load = Math.max(0, boatState.throttle);
  if (!boatState.engineStalled) boatState.fuel = clamp(boatState.fuel - dt * (0.035 + load * load * 0.22), 0, 100);
  const targetTemp = 28 + load * 92 + Math.max(0, boatState.water - 45) * 0.12;
  boatState.engineTemp += (targetTemp - boatState.engineTemp) * dt * (load > 0 ? 0.12 : 0.08);
  if (boatState.fuel <= 0.01) {
    boatState.engineStalled = true;
    boatState.throttle = 0;
  }
  if (boatState.engineTemp >= 104 && !boatState.engineStalled) {
    boatState.engineStalled = true;
    boatState.throttle = 0;
    emit(world, "engine-stall", "Двигатель перегрелся и заглох.", targets);
  }

  boatState.water = clamp(
    boatState.water + boatState.leak * dt * 0.33 * unattendedLeakMultiplier(boatState, WORLD.shoreY),
    0,
    100,
  );
  boatState.pumpActive = Boolean(input.pump);
  if (boatState.pumpActive) boatState.water = clamp(boatState.water - dt * 7.5, 0, 100);
  processHullRepair(world, boatState, input, dt);

  if (boatState.water >= (CONFIG.engineFloodStallWater || 80) && !boatState.engineStalled) {
    boatState.engineStalled = true;
    boatState.throttle = 0;
    emit(world, "engine-flooded", "Вода залила моторный отсек. Откачай её до 35 процентов.", targets);
  }

  if (boatState.water >= 100 || boatState.hull <= 0) startEmergency(world, boatState, boatState.water >= 100 ? "flooded" : "wrecked");
  updateEmergency(world, boatState, dt);

  if (!boatState.emergencyActive && boatState.engineStalled && boatState.fuel > 0.01 && boatState.water <= (CONFIG.waterEngineRestartWater || 35) && boatState.hull >= (CONFIG.floodRecoveryHull || 5) && boatState.engineTemp < 92) {
    boatState.restartProgress += dt;
    if (boatState.restartProgress >= (CONFIG.waterEngineRestartDelay || 1.2)) {
      boatState.engineStalled = false;
      boatState.restartProgress = 0;
      emit(world, "engine-water-restart", "Мотор запущен.", targets);
    }
  } else if (!boatState.engineStalled || boatState.water > (CONFIG.waterEngineRestartWater || 35)) {
    boatState.restartProgress = 0;
  }
}

function boundaryBlocksThrust(boatState, thrust) {
  const side = boatState.boundaryContact;
  if (!side || !thrust) return false;
  const direction = Math.sign(thrust);
  const heading = rad(boatState.heading);
  const requested = {
    x: Math.sin(heading) * direction,
    y: -Math.cos(heading) * direction,
  };
  return (side === "left" && requested.x < -0.03)
    || (side === "right" && requested.x > 0.03)
    || (side === "open-water" && requested.y > 0.03)
    || (side === "shore" && requested.y < -0.03);
}

function resolveBoatCollision(world) {
  const a = world.boats[0];
  const b = world.boats[1];
  if (a.sunk || b.sunk) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const metres = Math.hypot(dx, dy);
  const minimum = WORLD.boatRadius * 2;
  if (metres >= minimum || metres <= 0.001) return;
  const nx = dx / metres;
  const ny = dy / metres;
  const overlap = minimum - metres;
  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;

  const impactSpeed = Math.abs(a.speed - b.speed) + Math.abs(a.speed) * 0.35 + Math.abs(b.speed) * 0.35;
  if (impactSpeed <= 2 || a.collisionCooldown > 0 || b.collisionCooldown > 0) return;
  const severity = collisionSeverity(impactSpeed);
  const impactA = applyCollisionDamage(a, 15 * severity);
  const impactB = applyCollisionDamage(b, 15 * severity);
  a.leak = clamp(a.leak + impactA.damage * 0.08, 0, 16);
  b.leak = clamp(b.leak + impactB.damage * 0.08, 0, 16);
  a.speed *= -0.22;
  b.speed *= -0.22;
  a.collisionCooldown = 1.25;
  b.collisionCooldown = 1.25;
  emit(world, "ram", `Столкновение лодок. Корпус минус ${Math.round(impactA.damage)} и ${Math.round(impactB.damage)}.`, [0, 1], {strength: impactSpeed});
}

function updateTow(world, dt) {
  if ((Number(world.version) || 0) >= 5) return;
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
  const metres = Math.hypot(dx, dy) || 0.001;
  const excess = Math.max(0, metres - WORLD.towLength);
  const nx = dx / metres;
  const ny = dy / metres;
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
    const error = Math.abs(wrapDeg(towed.heading - desiredHeading));
    if (error <= 55) {
      tow.tension = Math.max(0, tow.tension - 0.8 * dt);
      towed.speed += Math.max(0, tower.speed) * 0.18 * dt;
    } else opposition = clamp((error - 55) / 100, 0, 1);
  }
  tow.tension = clamp(tow.tension + (excess / 10 + opposition * 0.9) * dt - 0.35 * dt, 0, 1.5);
  if (tow.tension > 0.92) tow.strainTime += dt;
  else tow.strainTime = Math.max(0, tow.strainTime - dt * 1.4);

  if (tow.strainTime > 2.1 || metres > WORLD.towLength * 2.2) {
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
  const otherIndex = 1 - playerIndex;
  const other = world.players[otherIndex];
  const modeLabel = p.mode === "boat" ? "в лодке" : p.mode === "foot" ? "на берегу" : p.mode === "roof" ? "на крыше лодки" : "в воде";
  const parts = [`Ты ${modeLabel}.`];
  if (["boat", "roof"].includes(p.mode)) {
    const b = world.boats[p.activeBoat];
    parts.push(`Скорость ${Math.abs(b.speed).toFixed(1)}. Корпус ${Math.round(b.hull)}. Вода ${Math.round(b.water)}. Топливо ${Math.round(b.fuel)}. Пластин ${b.repairPatches}.`);
    if (b.emergencyActive) parts.push(`Аварийное время ${Math.ceil(b.emergencyRemaining)} секунд.`);
    if (world.tow?.towerBoat === b.id) parts.push("Ты буксируешь вторую лодку.");
    if (world.tow?.towedBoat === b.id) parts.push("Тебя буксируют; насос и пластина работают на ходу.");
  }
  const presence = world.freeActivities?.presence;
  if (!presence || presence[otherIndex]) {
    parts.push(`Другой игрок в ${Math.round(distance(p, other))} метрах.`);
  }
  return parts.join(" ");
}

export function snapshotWorld(world) {
  return JSON.parse(JSON.stringify({...world, events: []}));
}
