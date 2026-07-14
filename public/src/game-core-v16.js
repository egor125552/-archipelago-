"use strict";

import * as base from "./game-core-v15.js?base=6";
import {applyCollisionDamage} from "./collision-model.js";
import {
  chooseHunterTactic,
  ensureHunterBrain,
  hunterTacticalTarget,
  hunterTacticLabel,
  hunterTacticSpeedScale,
  noteHunterDecoy,
  noteHunterOutcome,
  updateHunterBrainMemory,
} from "./hunter-brain.js?v=25.0";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  debrisRemovalDuration: 9,
  debrisToolsDuration: 5.5,
  debrisSpeedPenalty: 0.1,
  hunterSpawnDelay: 14,
  hunterRamCooldown: 3.6,
  hunterMaxSpeed: 28.5,
  hunterCollisionRadius: 9,
  hunterHull: 100,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = value => value * 180 / Math.PI;
const rad = value => value * Math.PI / 180;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clock = state => Number.isFinite(state.totalElapsed) ? state.totalElapsed : Number(state.elapsed) || 0;

const ADVANCED_WORLDS = Object.freeze({
  4: Object.freeze({
    name: "Расколотый пролив",
    bounds: {minX: -105, maxX: 105, minY: -12, maxY: 235},
    survivorA: {x: 36, y: 112},
    survivorB: {x: -42, y: 205},
    hazards: [
      ["w4-barge-west", "разбитая баржа слева", -48, 48, 7, 12, 36],
      ["w4-pier-east", "обломки причала справа", 63, 76, 6, 11, 32],
      ["w4-cargo-mid", "грузовая секция слева", -65, 120, 7, 13, 40],
      ["w4-trawler-east", "остов траулера справа", 64, 154, 8, 14, 46],
      ["w4-deck-west", "палубные обломки слева", -72, 172, 6, 11, 30],
      ["w4-bow-north", "оторванный нос справа", 28, 222, 6, 12, 34],
      ["w4-reef", "каменная гряда у западного берега", -88, 110, 10, 23, 0, "reef"],
      ["w4-caisson", "бетонный кессон у восточного берега", 86, 202, 10, 25, 0, "structure"],
    ],
  }),
  5: Object.freeze({
    name: "Кладбище барж",
    bounds: {minX: -135, maxX: 135, minY: -12, maxY: 305},
    survivorA: {x: 52, y: 145},
    survivorB: {x: -64, y: 270},
    hazards: [
      ["w5-stern-west", "корма баржи слева", -60, 55, 7, 13, 38],
      ["w5-raft-east", "плот обломков справа", 72, 62, 6, 11, 30],
      ["w5-crane-west", "секция крана слева", -95, 105, 8, 15, 48],
      ["w5-pontoon-east", "понтон справа", 90, 120, 8, 14, 44],
      ["w5-hold-west", "трюм баржи слева", -85, 160, 9, 16, 54],
      ["w5-deck-east", "палуба баржи справа", 85, 185, 8, 14, 46],
      ["w5-cargo-west", "грузовые обломки слева", -105, 205, 7, 12, 36],
      ["w5-bow-east", "нос сухогруза справа", 70, 235, 9, 16, 52],
      ["w5-piles-west", "сваи с металлом слева", -112, 270, 7, 13, 38],
      ["w5-cabin-north", "рубка справа", 30, 292, 7, 13, 40],
      ["w5-breakwater", "бетонный волнолом слева", -122, 150, 11, 27, 0, "structure"],
      ["w5-reef", "северный риф справа", 118, 268, 11, 26, 0, "reef"],
    ],
  }),
  6: Object.freeze({
    name: "Чёрный рейд",
    bounds: {minX: -170, maxX: 170, minY: -12, maxY: 390},
    survivorA: {x: 70, y: 190},
    survivorB: {x: -82, y: 345},
    hazards: [
      ["w6-plates-west", "листы металла слева", -70, 55, 7, 12, 34],
      ["w6-raft-east", "плавучие обломки справа", 85, 70, 7, 12, 34],
      ["w6-barge-west", "борт баржи слева", -120, 100, 9, 16, 54],
      ["w6-pontoon-east", "тяжёлый понтон справа", 115, 125, 9, 16, 52],
      ["w6-crane-west", "крановая секция слева", -92, 170, 8, 15, 48],
      ["w6-deck-east", "палубные плиты справа", 132, 185, 8, 14, 44],
      ["w6-hold-west", "разорванный трюм слева", -120, 225, 10, 17, 58],
      ["w6-bow-east", "нос баржи справа", 115, 240, 9, 16, 52],
      ["w6-cargo-west", "контейнеры слева", -145, 280, 8, 14, 44],
      ["w6-stern-east", "корма сухогруза справа", 110, 300, 10, 17, 58],
      ["w6-ribs-west", "рёбра корпуса слева", -138, 345, 8, 15, 46],
      ["w6-cabin-east", "рубка справа", 60, 375, 8, 14, 44],
      ["w6-caisson", "бетонный кессон слева", -154, 185, 12, 29, 0, "structure"],
      ["w6-reef", "острый риф справа", 152, 330, 12, 29, 0, "reef"],
      ["w6-breakwater", "затопленный волнолом слева", -158, 374, 11, 28, 0, "structure"],
    ],
  }),
});

const RAM_MULTIPLIER = Object.freeze({strizh: 1, kasatka: 0.92, burevestnik: 1.12, grom: 1.7});

function buildHazard(row) {
  const [id, label, x, y, radius, damage, durability, type = "wreck"] = row;
  const breakable = durability > 0;
  return {
    id, label, x, y, radius, damage, type,
    breakable,
    durability,
    maxDurability: durability,
    fragmentRisk: breakable,
  };
}

function configureAdvancedWorld(state) {
  const level = state.progression?.level || 1;
  if (state.world?.campaignVersion === 16 && state.world?.campaignLevel === level) return;
  const spec = ADVANCED_WORLDS[level];
  if (!spec) {
    state.world.campaignVersion = 16;
    state.world.campaignLevel = level;
    for (const hazard of state.world.hazards) {
      hazard.breakable = false;
      hazard.durability = 0;
      hazard.maxDurability = 0;
    }
    return;
  }

  const previousSurvivors = new Map((state.world.survivors || []).map(item => [item.id, item]));
  state.world.version = 13;
  state.world.campaignVersion = 16;
  state.world.campaignLevel = level;
  state.world.name = `Бухта Северный Приют: ${spec.name}`;
  state.world.bounds = {...spec.bounds};
  state.world.hazards = spec.hazards.map(buildHazard);
  state.world.survivors = [
    {id: "survivor-a", label: "первый человек", ...spec.survivorA, rescued: false, progress: 0},
    {id: "survivor-b", label: "второй человек", ...spec.survivorB, rescued: false, progress: 0},
  ].map(item => {
    const previous = previousSurvivors.get(item.id);
    return previous ? {...item, rescued: Boolean(previous.rescued), progress: Number(previous.progress) || 0} : item;
  });
  state.world.harbor = {id: "harbor", label: "южная гавань", x: 0, y: 0, radius: 20};
  state.world.current = {x: 0, y: 0};
  state.world.storm = {intensity: 0, target: 0};
}

function ensureDebris(state) {
  state.debris ||= {};
  if (!Array.isArray(state.debris.pieces)) state.debris.pieces = [];
  if (!Array.isArray(state.debris.embeddedSources)) state.debris.embeddedSources = [];
  if (typeof state.debris.removing !== "boolean") state.debris.removing = false;
  if (!Number.isFinite(state.debris.progress)) state.debris.progress = 0;
  if (!Number.isInteger(state.debris.lastQuarter)) state.debris.lastQuarter = 0;
  if (!Number.isFinite(state.boat.baseMaxSpeedMultiplier)) {
    state.boat.baseMaxSpeedMultiplier = Number(state.boat.maxSpeedMultiplier) || 1;
  }
  applyDebrisSpeedPenalty(state);
}

function ensureHunter(state) {
  state.hunter ||= {};
  const enabled = (state.progression?.level || 1) === 6;
  if (typeof state.hunter.enabled !== "boolean") state.hunter.enabled = enabled;
  state.hunter.enabled = enabled;
  if (!Number.isFinite(state.hunter.x)) state.hunter.x = -105;
  if (!Number.isFinite(state.hunter.y)) state.hunter.y = 28;
  if (!Number.isFinite(state.hunter.heading)) state.hunter.heading = 28;
  if (!Number.isFinite(state.hunter.speed)) state.hunter.speed = 0;
  if (!Number.isFinite(state.hunter.ramCooldown)) state.hunter.ramCooldown = 0;
  if (!Number.isFinite(state.hunter.recoverUntil)) state.hunter.recoverUntil = 0;
  if (!Number.isFinite(state.hunter.repositionUntil)) state.hunter.repositionUntil = 0;
  if (!Number.isFinite(state.hunter.nextCueAt)) state.hunter.nextCueAt = CONFIG.hunterSpawnDelay;
  if (!Number.isInteger(state.hunter.decoyCharges)) state.hunter.decoyCharges = enabled ? 2 : 0;
  if (!Number.isFinite(state.hunter.decoyUntil)) state.hunter.decoyUntil = 0;
  if (!Number.isFinite(state.hunter.decoyX)) state.hunter.decoyX = 0;
  if (!Number.isFinite(state.hunter.decoyY)) state.hunter.decoyY = 0;
  if (!Number.isFinite(state.hunter.maxHull)) state.hunter.maxHull = CONFIG.hunterHull;
  if (!Number.isFinite(state.hunter.hull)) state.hunter.hull = state.hunter.maxHull;
  state.hunter.hull = clamp(state.hunter.hull, 0, state.hunter.maxHull);
  if (typeof state.hunter.destroyed !== "boolean") state.hunter.destroyed = state.hunter.hull <= 0;
  state.hunter.avoidance ||= {};
  const avoidance = state.hunter.avoidance;
  if (avoidance.version !== 1) {
    Object.assign(avoidance, {
      version: 1,
      hazardId: null,
      side: 0,
      lockedUntil: 0,
      waypointX: 0,
      waypointY: 0,
      blocked: false,
      sideChanges: 0,
      lastSideChangeAt: 0,
    });
  }
  const brain = ensureHunterBrain(state);
  state.hunter.mode = brain.tactic;
}

function ensureV16State(state) {
  if (!state || typeof state !== "object") return state;
  configureAdvancedWorld(state);
  ensureDebris(state);
  ensureHunter(state);
  return state;
}

function applyDebrisSpeedPenalty(state) {
  const count = state.debris?.pieces?.length || 0;
  const multiplier = clamp(1 - count * CONFIG.debrisSpeedPenalty, 0.62, 1);
  state.boat.maxSpeedMultiplier = state.boat.baseMaxSpeedMultiplier * multiplier;
  state.boat.embeddedDebris = count;
}

function canUseSystems(state, actor) {
  return state.mode !== "coop" || actor === "crew";
}

function deny(state, message, reason) {
  state.message = message;
  return {ok: false, reason, events: [{type: "ui-deny"}]};
}

function beginDebrisRemoval(state, actor) {
  if (state.phase !== "playing") return deny(state, "Операция не активна.", "not-playing");
  if (!canUseSystems(state, actor)) return deny(state, "Обломок извлекает оператор.", "crew-only");
  if (!state.debris.pieces.length) return deny(state, "В корпусе нет обломков.", "none");
  if (state.debris.removing) {
    state.debris.removing = false;
    state.debris.progress = 0;
    state.message = "Извлечение отменено.";
    return {ok: true, events: [{type: "debris-remove-cancel"}]};
  }
  if (state.damageControl?.floodEmergency) return deny(state, "Сначала насос и пластина.", "emergency");
  if (Math.abs(state.boat.speed) > 0.25) return deny(state, "Сначала останови лодку.", "too-fast");
  if (state.controls.rescue || state.controls.hullRepair || state.engineService?.active) {
    return deny(state, "Сначала закончи текущий ремонт.", "busy");
  }
  state.controls.forward = false;
  state.controls.reverse = false;
  state.boat.throttle = 0;
  state.boat.speed = 0;
  state.debris.removing = true;
  state.debris.progress = 0;
  state.debris.lastQuarter = 0;
  state.message = "Извлечение начато. Не двигайся.";
  return {ok: true, events: [{type: "debris-remove-start"}]};
}

function cancelDebrisRemoval(state, events, message) {
  if (!state.debris.removing) return;
  state.debris.removing = false;
  state.debris.progress = 0;
  state.debris.lastQuarter = 0;
  state.message = message;
  events.push({type: "debris-remove-cancel"});
}

function processDebrisRemoval(state, dt, events) {
  if (!state.debris.removing) return;
  if (state.phase !== "playing" || state.damageControl?.floodEmergency) {
    cancelDebrisRemoval(state, events, "Извлечение прервано.");
    return;
  }
  if (Math.abs(state.boat.speed) > 0.25 || state.controls.forward || state.controls.reverse) {
    cancelDebrisRemoval(state, events, "Лодка сдвинулась. Начни снова.");
    return;
  }
  if (state.controls.rescue || state.controls.hullRepair || state.engineService?.active) {
    cancelDebrisRemoval(state, events, "Извлечение прервано другим действием.");
    return;
  }
  state.boat.speed = 0;
  state.boat.throttle = 0;
  const duration = state.progression?.upgrades?.debrisTools
    ? CONFIG.debrisToolsDuration
    : CONFIG.debrisRemovalDuration;
  state.debris.progress = clamp(state.debris.progress + dt / duration * 100, 0, 100);
  const quarter = Math.min(4, Math.floor(state.debris.progress / 25));
  if (quarter > state.debris.lastQuarter && quarter < 4) {
    state.debris.lastQuarter = quarter;
    state.message = `Обломок: ${quarter * 25}%.`;
    events.push({type: "debris-remove-progress", percent: quarter * 25});
  }
  if (state.debris.progress < 100) return;

  const piece = state.debris.pieces.shift();
  state.debris.removing = false;
  state.debris.progress = 0;
  state.debris.lastQuarter = 0;
  state.boat.leak = clamp((Number(state.boat.leak) || 0) - (piece?.leak || 1.2), 0, 16);
  applyDebrisSpeedPenalty(state);
  state.message = state.debris.pieces.length ? "Обломок извлечён. В корпусе есть ещё." : "Обломок извлечён.";
  events.push({type: "debris-remove-complete", remaining: state.debris.pieces.length});
}

function processBreakableCollision(state, event, events) {
  if (event.type !== "collision") return;
  // Shoreline contacts are emitted without physical impact fields by v7 and
  // must never be mistaken for a nearby breakable wreck at the water's edge.
  if (!Number.isFinite(event.impactSpeed) && !Number.isFinite(event.damage)) return;
  const hazard = event.hazardId
    ? state.world.hazards.find(item => item.id === event.hazardId)
    : state.world.hazards
      .map(item => ({item, edge: distance(state.boat, item) - item.radius}))
      .filter(entry => entry.edge <= 5.5)
      .sort((left, right) => left.edge - right.edge)[0]?.item;
  if (hazard && !event.hazardId) event.hazardId = hazard.id;
  if (!hazard?.breakable) return;
  const speed = Math.abs(Number(event.impactSpeed) || 0);
  const modelRam = RAM_MULTIPLIER[state.boat.modelId] || 1;
  const keel = state.progression?.upgrades?.ramKeel ? 1.45 : 1;
  const ramForce = (4 + Math.pow(speed, 1.5) * 0.58) * modelRam * keel;
  hazard.durability = clamp(hazard.durability - ramForce, 0, hazard.maxDurability);
  event.wreckDamage = ramForce;
  event.wreckDurability = hazard.durability;
  event.breakable = true;

  if (speed > 8) {
    const keelProtection = state.progression?.upgrades?.ramKeel ? 0.68 : 1;
    const rawDeformation = Math.pow(speed - 8, 1.22) * 0.42 * keelProtection;
    const deformation = applyCollisionDamage(state.boat, rawDeformation);
    event.damage = (Number(event.damage) || 0) + deformation.damage;
    event.deformationDamage = deformation.damage;
  }

  const embeddedBefore = state.debris.embeddedSources.includes(hazard.id);
  if (!embeddedBefore && speed >= 9 && ramForce >= 20 && hazard.fragmentRisk) {
    const leak = clamp(0.75 + speed / 24, 0.75, 1.8);
    state.debris.embeddedSources.push(hazard.id);
    state.debris.pieces.push({id: hazard.id, label: hazard.label, leak});
    state.boat.leak = clamp((Number(state.boat.leak) || 0) + leak, 0, 16);
    applyDebrisSpeedPenalty(state);
    events.push({type: "debris-embedded", hazardId: hazard.id, pan: event.pan || 0, count: state.debris.pieces.length});
  }

  if (hazard.durability > 0) {
    events.push({type: "wreck-crack", hazardId: hazard.id, pan: event.pan || 0, durability: hazard.durability});
    return;
  }
  state.world.hazards = state.world.hazards.filter(item => item.id !== hazard.id);
  state.score += 125;
  events.push({type: "wreck-destroyed", hazardId: hazard.id, pan: event.pan || 0, bonus: 125});
}

function hunterBearing(state) {
  const hunter = state.hunter;
  const absolute = deg(Math.atan2(hunter.x - state.boat.x, hunter.y - state.boat.y));
  const relative = wrapDeg(absolute - state.boat.heading);
  return {
    distance: distance(hunter, state.boat),
    relative,
    pan: clamp(relative / 78, -1, 1),
  };
}

function hunterDirection(relative) {
  if (Math.abs(relative) < 12) return "прямо";
  return relative < 0 ? "слева" : "справа";
}

function hunterTarget(state, now) {
  return hunterTacticalTarget(state, now);
}

function segmentHazardBlock(state, target) {
  const start = state.hunter;
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  let best = null;
  for (const hazard of state.world.hazards) {
    const hx = hazard.x - start.x;
    const hy = hazard.y - start.y;
    const along = hx * ux + hy * uy;
    if (along < -2 || along > length + 8) continue;
    const lateral = Math.abs(hx * uy - hy * ux);
    const clearance = hazard.radius + 10.5;
    if (lateral >= clearance) continue;
    const entry = along - Math.sqrt(Math.max(0, clearance * clearance - lateral * lateral));
    if (!best || entry < best.entry) best = {hazard, entry, along, ux, uy, length};
  }
  return best;
}

function avoidanceCandidateCost(state, hazard, target, side, ux, uy) {
  const clearance = hazard.radius + 17;
  const sideX = -uy * side;
  const sideY = ux * side;
  const waypoint = {
    x: hazard.x + sideX * clearance + ux * 7,
    y: hazard.y + sideY * clearance + uy * 7,
  };
  let cost = distance(state.hunter, waypoint) + distance(waypoint, target) * 0.72;
  for (const other of state.world.hazards) {
    if (other.id === hazard.id) continue;
    const metres = distance(waypoint, other);
    const safe = other.radius + 10;
    if (metres < safe) cost += (safe - metres) * 14;
  }
  const bounds = state.world.bounds;
  if (waypoint.x < bounds.minX + 15 || waypoint.x > bounds.maxX - 15) cost += 180;
  if (waypoint.y < bounds.minY + 15 || waypoint.y > bounds.maxY - 15) cost += 180;
  return {cost, waypoint};
}

function steerHunterAroundHazards(state, target, now) {
  const avoidance = state.hunter.avoidance;
  const block = segmentHazardBlock(state, target);
  let navigationTarget = target;

  if (block) {
    const {hazard, ux, uy} = block;
    const sameLockedHazard = avoidance.hazardId === hazard.id
      && avoidance.side !== 0
      && now < avoidance.lockedUntil;
    if (!sameLockedHazard) {
      const left = avoidanceCandidateCost(state, hazard, target, -1, ux, uy);
      const right = avoidanceCandidateCost(state, hazard, target, 1, ux, uy);
      const selected = left.cost <= right.cost ? {side: -1, ...left} : {side: 1, ...right};
      if (avoidance.side && avoidance.side !== selected.side) {
        avoidance.sideChanges += 1;
        avoidance.lastSideChangeAt = now;
      }
      avoidance.hazardId = hazard.id;
      avoidance.side = selected.side;
      avoidance.lockedUntil = now + 2.8;
      avoidance.waypointX = selected.waypoint.x;
      avoidance.waypointY = selected.waypoint.y;
    } else {
      const selected = avoidanceCandidateCost(state, hazard, target, avoidance.side, ux, uy);
      avoidance.waypointX = selected.waypoint.x;
      avoidance.waypointY = selected.waypoint.y;
    }
    avoidance.blocked = true;
    navigationTarget = {x: avoidance.waypointX, y: avoidance.waypointY};
  } else {
    avoidance.blocked = false;
    if (now >= avoidance.lockedUntil) {
      avoidance.hazardId = null;
      avoidance.side = 0;
    }
  }

  let dx = navigationTarget.x - state.hunter.x;
  let dy = navigationTarget.y - state.hunter.y;
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;

  // Keep only a weak local separation force. The locked waypoint owns the
  // side choice, so several nearby wrecks cannot flip it every frame.
  for (const hazard of state.world.hazards) {
    const hx = state.hunter.x - hazard.x;
    const hy = state.hunter.y - hazard.y;
    const metres = Math.hypot(hx, hy) || 1;
    const influence = hazard.radius + 11;
    if (metres >= influence) continue;
    const strength = Math.pow((influence - metres) / influence, 1.4) * 0.9;
    dx += hx / metres * strength;
    dy += hy / metres * strength;
  }

  const bounds = state.world.bounds;
  const margin = 18;
  if (state.hunter.x < bounds.minX + margin) dx += 2;
  if (state.hunter.x > bounds.maxX - margin) dx -= 2;
  if (state.hunter.y < bounds.minY + margin) dy += 2;
  if (state.hunter.y > bounds.maxY - margin) dy -= 2;
  return deg(Math.atan2(dx, dy));
}

function keepHunterSolid(state) {
  for (const hazard of state.world.hazards) {
    const safe = hazard.radius + 3.2;
    let dx = state.hunter.x - hazard.x;
    let dy = state.hunter.y - hazard.y;
    let metres = Math.hypot(dx, dy);
    if (metres >= safe) continue;
    if (metres < 0.01) { dx = 1; dy = 0; metres = 1; }
    state.hunter.x = hazard.x + dx / metres * (safe + 0.5);
    state.hunter.y = hazard.y + dy / metres * (safe + 0.5);
    state.hunter.heading = deg(Math.atan2(dx, dy));
    state.hunter.speed = -2;
  }
}

function separateBoats(state, nx, ny, playerDistance = 3.1, hunterDistance = 2.4) {
  state.boat.x += nx * playerDistance;
  state.boat.y += ny * playerDistance;
  state.hunter.x -= nx * hunterDistance;
  state.hunter.y -= ny * hunterDistance;
}

function damageHunter(state, amount, events, details = {}) {
  const hunter = state.hunter;
  const damage = clamp(Number(amount) || 0, 0, hunter.hull);
  hunter.hull = clamp(hunter.hull - damage, 0, hunter.maxHull);
  if (hunter.hull > 0 || hunter.destroyed) return {damage, destroyed: false};
  hunter.destroyed = true;
  hunter.speed = 0;
  hunter.mode = "recover";
  ensureHunterBrain(state).tactic = "recover";
  state.score += 700;
  events.push({type: "hunter-destroyed", damage, hunterHull: 0, bonus: 700, ...details});
  return {damage, destroyed: true};
}

function ramPlayer(state, events, now) {
  const hunter = state.hunter;
  const metres = distance(hunter, state.boat);
  if (hunter.destroyed || metres > CONFIG.hunterCollisionRadius || hunter.ramCooldown > 0 || state.damageControl?.floodEmergency) return;
  const playerHeading = rad(state.boat.heading);
  const hunterHeading = rad(hunter.heading);
  const playerVx = Math.sin(playerHeading) * state.boat.speed;
  const playerVy = Math.cos(playerHeading) * state.boat.speed;
  const hunterVx = Math.sin(hunterHeading) * hunter.speed;
  const hunterVy = Math.cos(hunterHeading) * hunter.speed;
  const relativeSpeed = Math.hypot(
    hunterVx - playerVx,
    hunterVy - playerVy,
  );
  if (relativeSpeed < 4.5) return;
  let dx = state.boat.x - hunter.x;
  let dy = state.boat.y - hunter.y;
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;
  const playerClosing = Math.max(0, -(playerVx * dx + playerVy * dy));
  const hunterClosing = Math.max(0, hunterVx * dx + hunterVy * dy);
  const playerLedImpact = Math.abs(state.boat.speed) >= 7.5 && playerClosing > hunterClosing + 0.75;
  const pan = hunterBearing(state).pan;

  separateBoats(state, dx, dy);
  hunter.ramCooldown = CONFIG.hunterRamCooldown;
  hunter.recoverUntil = now + CONFIG.hunterRamCooldown;
  hunter.mode = "retreat";
  hunter.nextDecisionAt = hunter.recoverUntil;
  if (state.progression) state.progression.collisionCount = (state.progression.collisionCount || 0) + 1;

  if (playerLedImpact) {
    const modelRam = RAM_MULTIPLIER[state.boat.modelId] || 1;
    const keel = state.progression?.upgrades?.ramKeel ? 1.45 : 1;
    const hunterDamage = clamp((5 + Math.pow(relativeSpeed, 1.18) * 0.72) * modelRam * keel, 8, 42);
    const selfImpact = applyCollisionDamage(state.boat, clamp(2.5 + relativeSpeed * 0.3, 4, 13));
    state.boat.speed *= 0.54;
    hunter.speed = -Math.max(3.2, Math.abs(hunter.speed) * 0.32);
    const result = damageHunter(state, hunterDamage, events, {pan, impactSpeed: relativeSpeed});
    events.push({
      type: "hunter-hit",
      damage: result.damage,
      hunterHull: hunter.hull,
      destroyed: hunter.destroyed,
      playerDamage: selfImpact.damage,
      absorbed: selfImpact.absorbed,
      impactSpeed: relativeSpeed,
      pan,
    });
    noteHunterOutcome(state, "hunter-hit", {damage: result.damage, impactSpeed: relativeSpeed});
    return;
  }

  const rawDamage = clamp(7 + Math.pow(relativeSpeed, 1.24) * 0.72, 9, 31);
  const impact = applyCollisionDamage(state.boat, rawDamage);
  const hunterImpact = damageHunter(state, clamp(2.5 + relativeSpeed * 0.26, 4, 12), events, {pan, impactSpeed: relativeSpeed});
  state.boat.speed *= 0.38;
  hunter.speed = -2.5;
  events.push({
    type: "hunter-ram",
    damage: impact.damage,
    absorbed: impact.absorbed,
    hunterDamage: hunterImpact.damage,
    hunterHull: hunter.hull,
    impactSpeed: relativeSpeed,
    pan,
  });
  noteHunterOutcome(state, "hunter-ram", {damage: impact.damage, impactSpeed: relativeSpeed});
}

function updateHunter(state, dt, events) {
  const hunter = state.hunter;
  if (!hunter.enabled || hunter.destroyed || state.phase !== "playing") return;
  const now = clock(state);
  hunter.ramCooldown = Math.max(0, hunter.ramCooldown - dt);
  updateHunterBrainMemory(state, dt, now);
  if (now < CONFIG.hunterSpawnDelay) return;
  const decision = chooseHunterTactic(state, now);
  if (decision.changed) events.push({type: "hunter-tactic", tactic: decision.tactic, confidence: decision.confidence});

  const recovering = now < hunter.recoverUntil;
  const playerDistance = distance(hunter, state.boat);
  let target = hunterTarget(state, now);
  if (!recovering && now >= hunter.repositionUntil && playerDistance < 13 && hunter.speed < 7.5) {
    hunter.repositionUntil = now + 1.8;
  }
  const repositioning = now < hunter.repositionUntil;
  if (recovering || repositioning) {
    const awayX = hunter.x - state.boat.x;
    const awayY = hunter.y - state.boat.y;
    target = {x: hunter.x + awayX, y: hunter.y + awayY, decoy: false};
  } else if (state.damageControl?.floodEmergency) {
    const angle = rad(state.boat.heading + 115);
    target = {x: state.boat.x + Math.sin(angle) * 34, y: state.boat.y + Math.cos(angle) * 34, decoy: false};
  }

  const desiredHeading = steerHunterAroundHazards(state, target, now);
  const headingError = wrapDeg(desiredHeading - hunter.heading);
  const turnRate = playerDistance < 38 ? 116 : 84;
  hunter.heading = wrapDeg(hunter.heading + clamp(headingError, -turnRate * dt, turnRate * dt));
  const targetDistance = distance(hunter, target);
  const turnFactor = clamp(1 - Math.abs(headingError) / 150, 0.35, 1);
  const damageFactor = 0.52 + 0.48 * hunter.hull / hunter.maxHull;
  const maxSpeed = CONFIG.hunterMaxSpeed * damageFactor;
  let desiredSpeed = Math.min(maxSpeed, 8 + targetDistance * 0.19) * turnFactor;
  desiredSpeed = Math.min(maxSpeed, desiredSpeed * hunterTacticSpeedScale(hunter.mode));
  if (["intercept", "block-objective", "ignore-decoy"].includes(hunter.mode) && playerDistance > 70) desiredSpeed = maxSpeed;
  if (recovering || repositioning) desiredSpeed = 13;
  if (state.damageControl?.floodEmergency) desiredSpeed = Math.min(desiredSpeed, 10);
  hunter.speed += clamp(desiredSpeed - hunter.speed, -13.5 * dt, 9.5 * damageFactor * dt);
  const heading = rad(hunter.heading);
  hunter.x += Math.sin(heading) * hunter.speed * dt;
  hunter.y += Math.cos(heading) * hunter.speed * dt;
  keepHunterSolid(state);
  const bounds = state.world.bounds;
  hunter.x = clamp(hunter.x, bounds.minX + 2, bounds.maxX - 2);
  hunter.y = clamp(hunter.y, bounds.minY + 2, bounds.maxY - 2);
  ramPlayer(state, events, now);

  if (!hunter.destroyed && now >= hunter.nextCueAt) {
    const bearing = hunterBearing(state);
    hunter.nextCueAt = now + clamp(bearing.distance / 70, 0.72, 1.8);
    events.push({type: "hunter-bearing", ...bearing, speed: hunter.speed, decoy: hunter.decoyUntil > now});
  }
}

function deployDecoy(state, actor) {
  if (state.phase !== "playing") return deny(state, "Операция не активна.", "not-playing");
  if (!state.hunter.enabled) return deny(state, "Преследователя нет.", "unavailable");
  if (!canUseSystems(state, actor)) return deny(state, "Буй сбрасывает оператор.", "crew-only");
  if (state.hunter.decoyCharges <= 0) return deny(state, "Ложных буёв нет.", "empty");
  state.hunter.decoyCharges -= 1;
  state.hunter.decoyX = state.boat.x;
  state.hunter.decoyY = state.boat.y;
  state.hunter.decoyUntil = clock(state) + 8;
  noteHunterDecoy(state);
  state.message = "Ложный буй сброшен. Уходи: повторный обман преследователь может распознать.";
  return {ok: true, events: [{type: "hunter-decoy", charges: state.hunter.decoyCharges}]};
}

function compactAdvancedMessage(state, events) {
  if (events.some(event => ["flood-emergency-start", "flood-emergency-warning", "flood-emergency-failed", "win", "lose"].includes(event.type))) return;
  const ram = events.find(event => event.type === "hunter-ram");
  const hunterHit = events.find(event => event.type === "hunter-hit");
  const hunterDestroyed = events.find(event => event.type === "hunter-destroyed");
  const embedded = events.find(event => event.type === "debris-embedded");
  const destroyed = events.find(event => event.type === "wreck-destroyed");
  const crack = events.find(event => event.type === "wreck-crack");
  if (hunterDestroyed) state.message = "Преследователь выведен из строя.";
  else if (hunterHit) state.message = `Попадание. Его корпус ${Math.round(hunterHit.hunterHull || 0)}%.`;
  else if (ram) state.message = `Таран. Корпус минус ${Math.round(ram.damage || 0)}%.`;
  else if (embedded) state.message = "Металл застрял в корпусе. Скорость снижена.";
  else if (destroyed) state.message = "Обломки разбиты. Путь открыт.";
  else if (crack) state.message = `Обломки повреждены: ${Math.ceil(crack.durability)}.`;
}

export function createGame(options = {}) {
  return ensureV16State(base.createGame(options));
}

export function startGame(state) {
  ensureV16State(state);
  base.startGame(state);
  if (state.phase === "playing") {
    const level = state.progression?.level || 1;
    if (level === 4) state.message = "Уровень 4. Лёгкие обломки ломаются от тарана.";
    else if (level === 5) state.message = "Уровень 5. Бетон не пробить. Слушай тип препятствия.";
    else if (level === 6) state.message = "Уровень 6. Через 14 секунд появится преследователь.";
  }
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  ensureV16State(state);
  return base.setControl(state, control, active, actor);
}

export function command(state, action, actor = "captain") {
  ensureV16State(state);
  if (action === "debris-remove") return beginDebrisRemoval(state, actor);
  if (action === "hunter-decoy") return deployDecoy(state, actor);
  const result = base.command(state, action, actor);
  if (action === "sonar" && result.ok && state.hunter.enabled && !state.hunter.destroyed && clock(state) >= CONFIG.hunterSpawnDelay) {
    const bearing = hunterBearing(state);
    state.message = `${state.message.replace(/\.$/, "")}. Катер ${hunterDirection(bearing.relative)}, ${Math.round(bearing.distance)} м.`;
  }
  return result;
}

export function step(state, dt) {
  ensureV16State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const events = base.step(state, safeDt) || [];
  for (const event of [...events]) processBreakableCollision(state, event, events);
  processDebrisRemoval(state, safeDt, events);
  updateHunter(state, safeDt, events);
  compactAdvancedMessage(state, events);
  return events;
}

export function getView(state) {
  ensureV16State(state);
  const view = base.getView(state);
  const now = clock(state);
  const hunterReady = state.hunter.enabled && !state.hunter.destroyed && now >= CONFIG.hunterSpawnDelay;
  const bearing = hunterReady ? hunterBearing(state) : null;
  const duration = state.progression?.upgrades?.debrisTools
    ? CONFIG.debrisToolsDuration
    : CONFIG.debrisRemovalDuration;
  return {
    ...view,
    boat: {
      ...view.boat,
      embeddedDebris: state.debris.pieces.length,
      speedPenalty: clamp(1 - state.boat.maxSpeedMultiplier / state.boat.baseMaxSpeedMultiplier, 0, 1),
    },
    debris: {
      count: state.debris.pieces.length,
      removing: state.debris.removing,
      progress: state.debris.progress,
      duration,
      canRemove: state.debris.pieces.length > 0
        && !state.damageControl?.floodEmergency
        && Math.abs(state.boat.speed) <= 0.25
        && !state.controls.rescue
        && !state.controls.hullRepair
        && !state.engineService?.active,
    },
    hunter: {
      enabled: state.hunter.enabled,
      active: hunterReady,
      arrivesIn: state.hunter.enabled ? Math.max(0, CONFIG.hunterSpawnDelay - now) : null,
      distance: bearing?.distance ?? null,
      relativeAngle: bearing?.relative ?? null,
      pan: bearing?.pan ?? 0,
      speed: state.hunter.speed,
      maxSpeed: CONFIG.hunterMaxSpeed * (0.52 + 0.48 * state.hunter.hull / state.hunter.maxHull),
      hull: state.hunter.hull,
      maxHull: state.hunter.maxHull,
      damaged: state.hunter.hull < state.hunter.maxHull,
      destroyed: state.hunter.destroyed,
      mode: state.hunter.destroyed ? "disabled" : state.hunter.mode,
      modeLabel: hunterTacticLabel(state, now),
      neural: {
        tactic: state.hunter.brain?.tactic || "pressure",
        confidence: state.hunter.brain?.confidence || 0,
        turnPersistence: state.hunter.brain?.turnPersistence || 0,
        reversePersistence: state.hunter.brain?.reversePersistence || 0,
        stationaryPersistence: state.hunter.brain?.stationaryPersistence || 0,
        ramBait: state.hunter.brain?.ramBait || 0,
        decoySuspicion: state.hunter.brain?.decoySuspicion || 0,
        failedAttacks: state.hunter.brain?.failedAttacks || 0,
        history: [...(state.hunter.brain?.tacticHistory || [])],
      },
      ramCooldown: state.hunter.ramCooldown,
      decoyCharges: state.hunter.decoyCharges,
      decoyActive: state.hunter.decoyUntil > now,
    },
    world: {
      ...view.world,
      bounds: {...state.world.bounds},
      hazardCount: state.world.hazards.length,
      breakableCount: state.world.hazards.filter(item => item.breakable).length,
    },
  };
}

export function getRoutePlan(state, targetId) {
  return base.getRoutePlan(ensureV16State(state), targetId);
}

export function serialize(state) {
  return base.serialize(ensureV16State(state));
}

export function deserialize(value) {
  return ensureV16State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
