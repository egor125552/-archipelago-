"use strict";

import * as base from "./game-core-v17.js?base=9";
import {applyCollisionDamage, collisionSeverity} from "./collision-model.js";

export const CONFIG = Object.freeze({
  ...base.CONFIG,
  shoreInset: 2.4,
  shoreImpactCooldown: 1.35,
  shoreScrapeSpeed: 1.25,
  shoreHardImpactSpeed: 5,
  shoreBaseDamage: 6,
  shoreSeverityDamage: 15,
  floatingBrakeCooldown: 12,
  emergencyFuelAmount: 30,
  emergencyFuelDuration: 4.5,
  harborFuelDuration: 3,
  harborFuelRange: 24,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clock = state => Number.isFinite(state.totalElapsed) ? state.totalElapsed : Number(state.elapsed) || 0;

function canUseSystems(state, actor) {
  return state.mode !== "coop" || actor === "crew";
}

function deny(state, message, reason) {
  state.message = message;
  return {ok: false, reason, events: [{type: "ui-deny"}]};
}

function atHarbor(state) {
  return distance(state.boat, state.world.harbor) <= CONFIG.harborFuelRange;
}

function ensureV18State(state) {
  if (!state || typeof state !== "object") return state;
  state.shoreImpact ||= {};
  if (!Number.isFinite(state.shoreImpact.lastAt)) state.shoreImpact.lastAt = -999;
  state.floatingBrake ||= {};
  if (!Number.isFinite(state.floatingBrake.readyAt)) state.floatingBrake.readyAt = 0;
  state.refuel ||= {};
  if (!Number.isInteger(state.refuel.canisters)) state.refuel.canisters = 1;
  state.refuel.canisters = clamp(state.refuel.canisters, 0, 1);
  if (typeof state.refuel.active !== "boolean") state.refuel.active = false;
  if (!Number.isFinite(state.refuel.progress)) state.refuel.progress = 0;
  if (!Number.isInteger(state.refuel.lastQuarter)) state.refuel.lastQuarter = 0;
  if (!state.refuel.source) state.refuel.source = null;
  if (typeof state.refuel.wasEngineRunning !== "boolean") state.refuel.wasEngineRunning = false;
  if (typeof state.refuel.emptyAnnounced !== "boolean") state.refuel.emptyAnnounced = false;
  return state;
}

function shorelineSide(state) {
  const {boat, world: {bounds}} = state;
  const candidates = [
    {side: "left", distance: boat.x - bounds.minX, pan: -0.9},
    {side: "right", distance: bounds.maxX - boat.x, pan: 0.9},
    {side: "back", distance: boat.y - bounds.minY, pan: 0},
    {side: "front", distance: bounds.maxY - boat.y, pan: 0},
  ];
  return candidates.sort((left, right) => left.distance - right.distance)[0];
}

function pushFromShore(state, side) {
  const bounds = state.world.bounds;
  if (side === "left") state.boat.x = bounds.minX + CONFIG.shoreInset;
  else if (side === "right") state.boat.x = bounds.maxX - CONFIG.shoreInset;
  else if (side === "back") state.boat.y = bounds.minY + CONFIG.shoreInset;
  else state.boat.y = bounds.maxY - CONFIG.shoreInset;
}

function strengthenShoreImpact(state, events, previousSpeed, previousMessage) {
  const index = events.findIndex(event => event.type === "collision"
    && !Number.isFinite(event.damage)
    && !Number.isFinite(event.impactSpeed));
  if (index < 0) return;
  if (state.phase !== "playing") {
    events.splice(index, 1);
    return;
  }
  const contact = shorelineSide(state);
  pushFromShore(state, contact.side);
  state.controls.forward = false;
  state.controls.reverse = false;
  state.boat.throttle = 0;

  const now = clock(state);
  if (now - state.shoreImpact.lastAt < CONFIG.shoreImpactCooldown) {
    events.splice(index, 1);
    if (!events.length) state.message = previousMessage;
    return;
  }

  state.shoreImpact.lastAt = now;
  const impactSpeed = Math.abs(Number(previousSpeed) || 0);
  const severity = collisionSeverity(impactSpeed);
  const scrape = impactSpeed <= CONFIG.shoreScrapeSpeed;
  const hardImpact = impactSpeed >= CONFIG.shoreHardImpactSpeed;
  const damageRamp = clamp(
    (impactSpeed - CONFIG.shoreScrapeSpeed) / (CONFIG.shoreHardImpactSpeed - CONFIG.shoreScrapeSpeed),
    0,
    1,
  );
  const rawDamage = scrape
    ? 0
    : (CONFIG.shoreBaseDamage + CONFIG.shoreSeverityDamage * severity) * damageRamp;
  const impact = applyCollisionDamage(state.boat, rawDamage);
  const rebound = Math.min(impactSpeed, Math.max(0.35, impactSpeed * 0.35));
  state.boat.speed = scrape ? 0 : -Math.sign(previousSpeed || 1) * rebound;
  const event = events[index];
  Object.assign(event, {
    shore: true,
    hazardId: "shore",
    severity: scrape ? 0.2 : severity,
    scrape,
    hardImpact,
    damage: impact.damage,
    absorbed: impact.absorbed,
    armor: impact.armor,
    impactSpeed,
    pan: contact.pan,
  });
  if (scrape) {
    state.message = "Лодка мягко коснулась берега. Корпус не повреждён.";
  } else {
    const armor = impact.absorbed > 0 ? ` Броня приняла ${Math.round(impact.absorbed)}.` : "";
    const impactText = hardImpact ? "Сильный удар" : "Удар";
    const damageText = impact.damage < 1 ? impact.damage.toFixed(1) : Math.round(impact.damage);
    state.message = `${impactText} о берег. Корпус минус ${damageText}%.${armor}`;
  }
}

function refuelDuration(state) {
  return state.refuel.source === "harbor" ? CONFIG.harborFuelDuration : CONFIG.emergencyFuelDuration;
}

function refuelRestartSafe(state) {
  return state.boat.fuel > 0.01
    && !state.waterEngine?.locked
    && !state.damageControl?.floodEmergency
    && state.boat.water <= 35
    && state.boat.hull >= 5
    && state.boat.engineTemp < 92;
}

function canRefuelHere(state) {
  return atHarbor(state) || state.refuel.canisters > 0;
}

function beginRefuel(state, actor) {
  if (state.phase !== "playing") return deny(state, "Операция не активна.", "not-playing");
  if (!canUseSystems(state, actor)) return deny(state, "Заправкой занимается оператор.", "crew-only");
  if (state.refuel.active) {
    const events = [];
    cancelRefuel(state, events, "Заправка отменена.");
    return {ok: true, events};
  }
  if (state.boat.fuel >= 99.5) return deny(state, "Бак полный.", "full");
  if (Math.abs(state.boat.speed) > 0.25 || state.controls.forward || state.controls.reverse) {
    return deny(state, "Сначала останови лодку.", "too-fast");
  }
  if (state.damageControl?.floodEmergency) return deny(state, "Сначала стабилизируй лодку.", "emergency");
  if (state.controls.pump || state.controls.rescue || state.controls.hullRepair || state.engineService?.active || state.debris?.removing) {
    return deny(state, "Сначала закончи текущее действие.", "busy");
  }
  const harbor = atHarbor(state);
  if (!harbor && state.refuel.canisters <= 0) return deny(state, "Канистра пуста. Доберись до гавани.", "empty");

  state.controls.forward = false;
  state.controls.reverse = false;
  state.boat.throttle = 0;
  state.boat.speed = 0;
  state.refuel.active = true;
  state.refuel.progress = 0;
  state.refuel.lastQuarter = 0;
  state.refuel.source = harbor ? "harbor" : "canister";
  state.refuel.wasEngineRunning = !state.boat.engineStalled;
  state.boat.engineStalled = true;
  state.message = harbor ? "Заправка в гавани начата." : "Аварийная канистра подключена.";
  return {ok: true, events: [{type: "fuel-refuel-start", source: state.refuel.source}]};
}

function cancelRefuel(state, events, message) {
  if (!state.refuel.active) return;
  const restart = state.refuel.wasEngineRunning && refuelRestartSafe(state);
  state.refuel.active = false;
  state.refuel.progress = 0;
  state.refuel.lastQuarter = 0;
  state.refuel.source = null;
  state.refuel.wasEngineRunning = false;
  if (restart) state.boat.engineStalled = false;
  state.message = message;
  events.push({type: "fuel-refuel-cancel"});
}

function processRefuel(state, dt, events) {
  if (!state.refuel.active) return;
  if (state.phase !== "playing" || state.damageControl?.floodEmergency) {
    cancelRefuel(state, events, "Заправка прервана.");
    return;
  }
  if (Math.abs(state.boat.speed) > 0.25 || state.controls.forward || state.controls.reverse) {
    cancelRefuel(state, events, "Лодка сдвинулась. Заправка прервана.");
    return;
  }
  if (state.refuel.source === "harbor" && !atHarbor(state)) {
    cancelRefuel(state, events, "Лодка отошла от заправочного поста.");
    return;
  }
  state.boat.speed = 0;
  state.boat.throttle = 0;
  const duration = refuelDuration(state);
  state.refuel.progress = clamp(state.refuel.progress + dt / duration * 100, 0, 100);
  const quarter = Math.min(4, Math.floor(state.refuel.progress / 25));
  if (quarter > state.refuel.lastQuarter && quarter < 4) {
    state.refuel.lastQuarter = quarter;
    state.message = `Заправка ${quarter * 25}%.`;
    events.push({type: "fuel-refuel-progress", percent: quarter * 25});
  }
  if (state.refuel.progress < 100) return;

  const source = state.refuel.source;
  if (source === "canister") state.refuel.canisters = Math.max(0, state.refuel.canisters - 1);
  state.boat.fuel = source === "harbor"
    ? 100
    : clamp(state.boat.fuel + CONFIG.emergencyFuelAmount, 0, 100);
  state.refuel.active = false;
  state.refuel.progress = 0;
  state.refuel.lastQuarter = 0;
  state.refuel.source = null;
  state.refuel.emptyAnnounced = false;
  const canRestart = refuelRestartSafe(state);
  state.refuel.wasEngineRunning = false;
  if (canRestart) state.boat.engineStalled = false;
  state.message = canRestart
    ? `Заправка завершена. Топливо ${Math.round(state.boat.fuel)}%. Мотор запущен.`
    : `Заправка завершена. Топливо ${Math.round(state.boat.fuel)}%.`;
  events.push({type: "fuel-refuel-complete", source, fuel: state.boat.fuel, restarted: canRestart});
}

export function createGame(options = {}) {
  return ensureV18State(base.createGame(options));
}

export function startGame(state) {
  ensureV18State(state);
  return base.startGame(state);
}

export function setControl(state, control, active, actor = "captain") {
  ensureV18State(state);
  if (active && state.refuel.active && ["forward", "reverse", "pump", "rescue", "hullRepair"].includes(control)) {
    state.message = "Сначала отмени заправку.";
    return false;
  }
  if (active && control === "rescue" && state.world?.survivors?.length
    && state.world.survivors.every(item => item.rescued)) {
    state.message = "Все люди уже на борту. Трос больше не нужен; возвращайся в гавань.";
    return false;
  }
  if (active && control === "hullRepair" && state.boat.leak <= 0.05 && state.boat.hull >= 99) {
    state.message = "Корпус цел. Ремонтная пластина сейчас не нужна.";
    return false;
  }
  const result = base.setControl(state, control, active, actor);
  // The hull should coast after release, but the engine must stop
  // producing thrust immediately. Otherwise the boat accelerates for
  // several frames after the player has already let go of the button.
  if (result && !active && control === "forward" && state.boat.throttle > 0) state.boat.throttle = 0;
  if (result && !active && control === "reverse" && state.boat.throttle < 0) state.boat.throttle = 0;
  return result;
}

export function command(state, action, actor = "captain") {
  ensureV18State(state);
  if (state.refuel.active && ["quick", "repair", "debris-remove"].includes(action)) {
    return deny(state, "Сначала закончи или отмени заправку.", "refuel-busy");
  }
  if (action === "refuel") return beginRefuel(state, actor);
  if (action === "quick" && state.boat.fuel <= 0.01 && canRefuelHere(state)) return beginRefuel(state, actor);
  if (action === "anchor" && state.phase === "playing" && (state.mode !== "coop" || actor === "captain")) {
    const remaining = state.floatingBrake.readyAt - clock(state);
    if (remaining > 0) {
      return deny(state, `Плавучий тормоз восстанавливается: ${Math.ceil(remaining)} с.`, "brake-cooldown");
    }
    const alreadyStopped = Math.abs(state.boat.speed) <= CONFIG.motionStopSpeed
      && !state.controls.forward
      && !state.controls.reverse
      && Math.abs(state.boat.throttle) < 0.05;
    if (alreadyStopped) {
      return deny(state, "Лодка уже стоит. Плавучий тормоз не израсходован.", "already-stopped");
    }
    const result = base.command(state, action, actor);
    if (result.ok) state.floatingBrake.readyAt = clock(state) + CONFIG.floatingBrakeCooldown;
    return result;
  }
  return base.command(state, action, actor);
}

export function step(state, dt) {
  ensureV18State(state);
  const safeDt = clamp(Number(dt) || 0, 0, 0.25);
  const previousSpeed = state.boat.speed;
  const previousMessage = state.message;
  const sonarWasUnused = !state.navigation?.lockedTargetId
    && !(state.sonar?.pings > 0)
    && !state.sonar?.lastResult;
  const emptyGuard = state.phase === "playing"
    && state.boat.fuel <= 0.01
    && Math.abs(state.boat.speed) <= CONFIG.motionStopSpeed
    && canRefuelHere(state);
  if (emptyGuard) {
    state.boat.fuel = 0.011;
    state.boat.engineStalled = true;
  }
  const events = base.step(state, safeDt) || [];
  if (sonarWasUnused && !(state.sonar?.pings > 0)) {
    state.navigation.lockedTargetId = null;
    state.navigation.routeTargetId = null;
    state.navigation.routeStage = 0;
    state.navigation.courseHold = false;
    state.navigation.approachAssist = false;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "navigation-cue") events.splice(index, 1);
    }
  }
  if (events.some(event => event.type === "auto-stop")) {
    state.message = "Автотормоз наката погасил инерцию. Лодка полностью остановлена.";
  }
  if (emptyGuard && state.phase === "playing") state.boat.fuel = 0;
  strengthenShoreImpact(state, events, previousSpeed, previousMessage);
  processRefuel(state, safeDt, events);

  if (state.phase === "playing"
    && state.boat.fuel <= 0.01
    && canRefuelHere(state)
    && !state.refuel.active
    && !state.damageControl?.floodEmergency) {
    state.boat.engineStalled = true;
    if (!state.refuel.emptyAnnounced) {
      state.refuel.emptyAnnounced = true;
      state.message = atHarbor(state)
        ? "Топливо закончилось. Остановись и заправься в гавани."
        : "Топливо закончилось. Остановись и используй аварийную канистру.";
      events.push({type: "fuel-empty-ready", canisters: state.refuel.canisters, harbor: atHarbor(state)});
    }
  } else if (state.boat.fuel > 0.01) {
    state.refuel.emptyAnnounced = false;
  }
  return events;
}

export function getView(state) {
  ensureV18State(state);
  const view = base.getView(state);
  const harbor = atHarbor(state);
  const duration = state.refuel.source === "harbor" ? CONFIG.harborFuelDuration : CONFIG.emergencyFuelDuration;
  return {
    ...view,
    floatingBrake: {
      ready: state.phase === "playing" && state.floatingBrake.readyAt <= clock(state),
      cooldown: CONFIG.floatingBrakeCooldown,
      remaining: Math.max(0, state.floatingBrake.readyAt - clock(state)),
    },
    refuel: {
      active: state.refuel.active,
      progress: state.refuel.progress,
      source: state.refuel.source,
      duration,
      canisters: state.refuel.canisters,
      emergencyAmount: CONFIG.emergencyFuelAmount,
      atHarbor: harbor,
      canStart: state.phase === "playing"
        && state.boat.fuel < 99.5
        && Math.abs(state.boat.speed) <= 0.25
        && !state.damageControl?.floodEmergency
        && !state.controls.pump
        && !state.controls.rescue
        && !state.controls.hullRepair
        && !state.engineService?.active
        && !state.debris?.removing
        && (harbor || state.refuel.canisters > 0),
    },
    quickLabel: state.boat.fuel <= 0.01 && canRefuelHere(state)
      ? (harbor ? "Заправиться в гавани" : "Использовать аварийную канистру")
      : view.quickLabel,
  };
}

export function getRoutePlan(state, targetId) {
  return base.getRoutePlan(ensureV18State(state), targetId);
}

export function serialize(state) {
  return base.serialize(ensureV18State(state));
}

export function deserialize(value) {
  return ensureV18State(base.deserialize(value));
}

export const nearestSurvivor = base.nearestSurvivor;
