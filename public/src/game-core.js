"use strict";

export const CONFIG = Object.freeze({
  tickRate: 20,
  maxSpeed: 18,
  reverseSpeed: -5,
  acceleration: 7.2,
  drag: 0.42,
  turnRate: 0.92,
  sonarCooldown: 2.4,
  sonarRange: 95,
  rescueRadius: 10,
  rescueSpeedLimit: 3.2,
  rescueDuration: 3.2,
  missionDuration: 240,
});

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const rad = deg => deg * Math.PI / 180;
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function createWorld(seed = 9) {
  return {
    seed,
    hazards: [
      {id: "reef-a", type: "reef", x: -16, y: 62, radius: 8, damage: 19},
      {id: "wreck", type: "wreck", x: 13, y: 105, radius: 7, damage: 15},
      {id: "reef-b", type: "reef", x: -5, y: 164, radius: 10, damage: 24},
    ],
    survivors: [
      {id: "survivor-a", x: 20, y: 122, rescued: false, progress: 0},
      {id: "survivor-b", x: -22, y: 188, rescued: false, progress: 0},
    ],
    harbor: {x: 0, y: 240, radius: 16},
    current: {x: 0.45, y: 0.12},
    storm: {intensity: 0.2, target: 0.72},
  };
}

export function createGame(options = {}) {
  const mode = options.mode === "coop" ? "coop" : "solo";
  return {
    version: 1,
    mode,
    role: options.role || "captain",
    phase: "ready",
    elapsed: 0,
    score: 0,
    won: false,
    lost: false,
    ending: null,
    message: "Шторм рвёт связь. Спаси двух людей и доведи лодку до гавани.",
    boat: {
      x: 0,
      y: 0,
      heading: 0,
      speed: 0,
      throttle: 0,
      rudder: 0,
      hull: 100,
      water: 0,
      leak: 0,
      fuel: 100,
      engineTemp: 24,
      engineStalled: false,
      pumpActive: false,
      rescueActive: false,
      repairProgress: 0,
    },
    controls: {
      left: false,
      right: false,
      forward: false,
      reverse: false,
      pump: false,
      rescue: false,
    },
    sonar: {
      cooldown: 0,
      lastResult: null,
      pings: 0,
    },
    crew: {
      aiEnabled: mode === "solo",
      task: "watch",
      confidence: 0.65,
    },
    rescued: 0,
    collisions: {},
    eventLog: [],
    feedback: {rescueSpeedAt: -999},
    alerts: {waterHigh: false, waterCritical: false, hullLow: false, fuelLow: false, engineHot: false},
    world: createWorld(options.seed),
  };
}

export function startGame(state) {
  if (state.phase !== "ready") return state;
  state.phase = "playing";
  state.message = state.mode === "solo"
    ? "Помощник на борту. Ты ведёшь лодку; он подстрахует насос и ремонт."
    : "Экипаж на связи. Капитан ведёт лодку, второй игрок отвечает за системы.";
  pushEvent(state, "start", state.message);
  return state;
}

export function setControl(state, control, active, actor = "captain") {
  const captainControls = new Set(["left", "right", "forward", "reverse"]);
  const crewControls = new Set(["pump", "rescue"]);
  if (state.mode === "coop") {
    if (captainControls.has(control) && actor !== "captain") return false;
    if (crewControls.has(control) && actor !== "crew") return false;
  }
  if (!(control in state.controls)) return false;
  state.controls[control] = Boolean(active);
  return true;
}

export function command(state, action, actor = "captain") {
  if (state.phase === "ready" && action === "start") {
    startGame(state);
    return {ok: true, events: []};
  }
  if (state.phase !== "playing") {
    state.message = "Операция сейчас не активна.";
    return {ok: false, reason: "not-playing", events: [{type: "ui-deny"}]};
  }
  switch (action) {
    case "sonar":
      if (state.mode === "coop" && actor !== "crew") {
        state.message = "Сонар закреплён за системным оператором.";
        return {ok: false, reason: "crew-only", events: [{type: "ui-deny"}]};
      }
      return sonarPing(state);
    case "quick":
      return quickAction(state, actor);
    case "repair":
      if (state.mode === "coop" && actor !== "crew") {
        state.message = "Ремонт выполняет системный оператор.";
        return {ok: false, reason: "crew-only", events: [{type: "ui-deny"}]};
      }
      return repairEngine(state);
    case "anchor":
      state.boat.throttle = 0;
      state.boat.speed *= 0.35;
      state.message = "Плавучий тормоз сброшен. Лодка резко теряет ход.";
      pushEvent(state, "anchor", state.message);
      return {ok: true, events: [{type: "anchor"}]};
    default:
      state.message = "Эта команда сейчас недоступна.";
      return {ok: false, reason: "unknown-action", events: [{type: "ui-deny"}]};
  }
}

export function sonarPing(state) {
  if (state.sonar.cooldown > 0) {
    state.message = `Сонар перезаряжается: ${state.sonar.cooldown.toFixed(1)} секунды.`;
    return {ok: false, reason: "cooldown", events: [{type: "ui-deny"}]};
  }
  const targets = [
    ...state.world.hazards.map(h => ({...h, kind: "опасность"})),
    ...state.world.survivors.filter(s => !s.rescued).map(s => ({...s, radius: 0, kind: "человек"})),
    {...state.world.harbor, id: "harbor", kind: "гавань"},
  ];
  const boat = state.boat;
  const inRange = targets
    .map(target => ({target, distance: dist(boat, target)}))
    .filter(item => item.distance <= CONFIG.sonarRange)
    .sort((a, b) => a.distance - b.distance);
  const nearest = inRange[0];
  state.sonar.cooldown = CONFIG.sonarCooldown;
  state.sonar.pings += 1;
  if (!nearest) {
    state.sonar.lastResult = {kind: "clear", distance: CONFIG.sonarRange, pan: 0, relativeAngle: 0};
    state.message = "Сонар: в ближнем секторе чисто.";
    pushEvent(state, "sonar-clear", state.message);
    return {ok: true, events: [{type: "sonar", pan: 0, distance: CONFIG.sonarRange, kind: "clear"}]};
  }
  const absolute = deg(Math.atan2(nearest.target.x - boat.x, nearest.target.y - boat.y));
  const relative = wrapDeg(absolute - boat.heading);
  const pan = clamp(relative / 80, -1, 1);
  const side = Math.abs(relative) < 12 ? "прямо" : relative < 0 ? "слева" : "справа";
  const result = {
    kind: nearest.target.kind,
    id: nearest.target.id,
    distance: nearest.distance,
    relativeAngle: relative,
    pan,
  };
  state.sonar.lastResult = result;
  state.message = `Сонар: ${nearest.target.kind} ${side}, примерно ${Math.round(nearest.distance)} метров.`;
  pushEvent(state, "sonar", state.message, result);
  return {ok: true, events: [{type: "sonar", ...result}]};
}

function quickAction(state, actor) {
  if (state.mode === "coop" && actor === "captain") {
    state.boat.throttle = 0;
    state.boat.speed *= 0.72;
    state.message = "Капитан быстро сбрасывает ход, чтобы экипаж успел выполнить действие.";
    pushEvent(state, "quick-brake", state.message);
    return {ok: true, events: [{type: "anchor"}]};
  }
  const survivor = nearestSurvivor(state);
  if (survivor && survivor.distance <= CONFIG.rescueRadius + 3) {
    if (state.mode === "coop" && actor !== "crew") {
      state.message = "Капитан удерживает лодку. Трос должен подать второй игрок.";
      return {ok: false, reason: "crew-only", events: [{type: "ui-deny"}]};
    }
    state.controls.rescue = true;
    state.message = "Трос подан. Удерживай действие, пока человек не окажется на борту.";
    return {ok: true, events: [{type: "rope"}]};
  }
  if (state.boat.water > 12) {
    if (state.mode === "coop" && actor !== "crew") {
      state.message = "Насос находится у второго игрока.";
      return {ok: false, reason: "crew-only", events: [{type: "ui-deny"}]};
    }
    state.controls.pump = true;
    state.message = "Насос включён. Удерживай действие, чтобы откачать воду.";
    return {ok: true, events: [{type: "pump-start"}]};
  }
  return sonarPing(state);
}

function repairEngine(state) {
  if (!state.boat.engineStalled && state.boat.engineTemp < 92) {
    state.message = "Двигатель пока исправен. Лучше следить за температурой.";
    return {ok: false, reason: "not-needed", events: [{type: "ui-deny"}]};
  }
  state.boat.repairProgress = clamp(state.boat.repairProgress + 28, 0, 100);
  state.message = `Ремонт двигателя: ${Math.round(state.boat.repairProgress)} процентов.`;
  if (state.boat.repairProgress >= 100) {
    state.boat.engineStalled = false;
    state.boat.engineTemp = 54;
    state.boat.repairProgress = 0;
    state.message = "Двигатель снова работает.";
    pushEvent(state, "engine-repaired", state.message);
    return {ok: true, events: [{type: "repair-complete"}]};
  }
  return {ok: true, events: [{type: "repair"}]};
}

export function step(state, dt) {
  if (state.phase !== "playing" || state.won || state.lost) return [];
  dt = clamp(Number(dt) || 0, 0, 0.25);
  const events = [];
  const boat = state.boat;
  state.elapsed += dt;
  state.sonar.cooldown = Math.max(0, state.sonar.cooldown - dt);
  state.world.storm.intensity += (state.world.storm.target - state.world.storm.intensity) * dt * 0.012;

  const steer = Number(state.controls.right) - Number(state.controls.left);
  const thrust = Number(state.controls.forward) - Number(state.controls.reverse);
  boat.rudder += (steer - boat.rudder) * Math.min(1, dt * 7);
  boat.throttle += (thrust - boat.throttle) * Math.min(1, dt * 4.5);

  if (boat.engineStalled) boat.throttle = Math.min(0, boat.throttle);
  const targetSpeed = boat.throttle >= 0 ? boat.throttle * CONFIG.maxSpeed : boat.throttle * Math.abs(CONFIG.reverseSpeed);
  boat.speed += clamp(targetSpeed - boat.speed, -CONFIG.acceleration * dt, CONFIG.acceleration * dt);
  boat.speed *= Math.max(0, 1 - CONFIG.drag * dt * (0.12 + Math.abs(boat.speed) / CONFIG.maxSpeed * 0.16));

  const turnFactor = clamp(Math.abs(boat.speed) / 4.5, 0.18, 1.25);
  boat.heading = wrapDeg(boat.heading + boat.rudder * CONFIG.turnRate * turnFactor * dt * 60 * Math.sign(boat.speed || 1));
  const headingRad = rad(boat.heading);
  const stormPush = state.world.storm.intensity * 0.24;
  boat.x += (Math.sin(headingRad) * boat.speed + state.world.current.x + stormPush) * dt;
  boat.y += (Math.cos(headingRad) * boat.speed + state.world.current.y) * dt;

  const load = Math.max(0, boat.throttle);
  boat.fuel = clamp(boat.fuel - dt * (0.035 + load * load * 0.22), 0, 100);
  const targetTemp = 28 + load * 92 + Math.max(0, boat.water - 45) * 0.12;
  boat.engineTemp += (targetTemp - boat.engineTemp) * dt * (load > 0 ? 0.12 : 0.08);
  if (boat.fuel <= 0.01) {
    boat.engineStalled = true;
    boat.throttle = 0;
    state.message = "Топливо закончилось. Лодка идёт по инерции.";
  }
  if (boat.engineTemp >= 104 && !boat.engineStalled) {
    boat.engineStalled = true;
    boat.throttle = 0;
    state.message = "Двигатель перегрелся и заглох.";
    pushEvent(state, "engine-stall", state.message);
    events.push({type: "engine-stall"});
  }

  for (const hazard of state.world.hazards) {
    const contact = dist(boat, hazard) < hazard.radius + 2.1;
    const last = state.collisions[hazard.id] ?? -999;
    if (contact && state.elapsed - last > 1.25) {
      state.collisions[hazard.id] = state.elapsed;
      const severity = clamp(Math.abs(boat.speed) / 8, 0.35, 1.6);
      const damage = hazard.damage * severity;
      boat.hull = clamp(boat.hull - damage, 0, 100);
      boat.leak = clamp(boat.leak + damage * 0.13, 0, 16);
      boat.speed *= -0.22;
      state.message = `Удар о ${hazard.type === "reef" ? "риф" : "обломки"}. Корпус повреждён.`;
      pushEvent(state, "collision", state.message, {hazard: hazard.id, damage});
      events.push({type: "collision", severity, pan: hazard.x < boat.x ? -0.7 : 0.7});
    }
  }

  boat.water = clamp(boat.water + boat.leak * dt * 0.33, 0, 100);
  const pumpRequested = state.controls.pump;
  const aiPump = state.mode === "solo" && boat.water > 34 && !state.controls.rescue;
  boat.pumpActive = pumpRequested || aiPump;
  if (boat.pumpActive) {
    boat.water = clamp(boat.water - dt * (aiPump ? 4.8 : 7.5), 0, 100);
    boat.leak = clamp(boat.leak - dt * (aiPump ? 0.06 : 0.09), 0, 16);
  }

  if (state.mode === "solo" && boat.engineStalled && Math.abs(boat.speed) < 2.2) {
    boat.repairProgress = clamp(boat.repairProgress + dt * 17, 0, 100);
    if (boat.repairProgress >= 100) {
      boat.engineStalled = false;
      boat.engineTemp = 52;
      boat.repairProgress = 0;
      state.message = "Помощник закончил ремонт двигателя.";
      pushEvent(state, "ai-repair", state.message);
      events.push({type: "repair-complete"});
    }
  }

  const nearest = nearestSurvivor(state);
  const rescueRequested = state.controls.rescue;
  boat.rescueActive = Boolean(rescueRequested);
  if (nearest && rescueRequested) {
    if (nearest.distance > CONFIG.rescueRadius + 3) {
      nearest.survivor.progress = Math.max(0, nearest.survivor.progress - dt * 0.6);
    } else if (Math.abs(boat.speed) > CONFIG.rescueSpeedLimit) {
      nearest.survivor.progress = Math.max(0, nearest.survivor.progress - dt * 0.8);
      state.message = "Слишком быстро. Трос вырывает из рук — сбрось ход.";
      if (state.elapsed - state.feedback.rescueSpeedAt > 1.5) {
        state.feedback.rescueSpeedAt = state.elapsed;
        events.push({type: "ui-deny"});
      }
    } else {
      const soloAssist = state.mode === "solo" ? 1.25 : 1;
      nearest.survivor.progress += dt * soloAssist;
      if (nearest.survivor.progress >= CONFIG.rescueDuration) {
        nearest.survivor.rescued = true;
        nearest.survivor.progress = CONFIG.rescueDuration;
        state.rescued += 1;
        state.score += 500;
        state.controls.rescue = false;
        boat.rescueActive = false;
        state.message = `Человек на борту. Спасено: ${state.rescued} из 2.`;
        pushEvent(state, "rescued", state.message, {id: nearest.survivor.id});
        events.push({type: "rescue-complete"});
      }
    }
  }

  if (boat.engineTemp >= 88 && !state.alerts.engineHot) {
    state.alerts.engineHot = true;
    events.push({type: "warning", key: "engine-hot", critical: false});
  } else if (boat.engineTemp < 78) state.alerts.engineHot = false;

  if (boat.water >= 45 && !state.alerts.waterHigh) {
    state.alerts.waterHigh = true;
    events.push({type: "warning", key: "water-high", critical: false});
  } else if (boat.water < 32) state.alerts.waterHigh = false;

  if (boat.water >= 75 && !state.alerts.waterCritical) {
    state.alerts.waterCritical = true;
    events.push({type: "warning", key: "water-critical", critical: true});
  } else if (boat.water < 60) state.alerts.waterCritical = false;

  if (boat.hull <= 35 && !state.alerts.hullLow) {
    state.alerts.hullLow = true;
    events.push({type: "warning", key: "hull-low", critical: true});
  } else if (boat.hull > 45) state.alerts.hullLow = false;

  if (boat.fuel <= 18 && !state.alerts.fuelLow) {
    state.alerts.fuelLow = true;
    events.push({type: "warning", key: "fuel-low", critical: false});
  } else if (boat.fuel > 25) state.alerts.fuelLow = false;

  if (boat.hull <= 0 || boat.water >= 100) {
    state.lost = true;
    state.phase = "finished";
    state.ending = boat.water >= 100 ? "flooded" : "wrecked";
    state.message = "Лодка потеряна. Экипаж подаёт аварийный сигнал.";
    pushEvent(state, "lose", state.message);
    events.push({type: "lose"});
  } else if (state.elapsed >= CONFIG.missionDuration) {
    state.lost = true;
    state.phase = "finished";
    state.ending = "storm";
    state.message = "Шторм закрыл проход к гавани. Время вышло.";
    pushEvent(state, "lose", state.message);
    events.push({type: "lose"});
  } else if (state.rescued >= 2 && dist(boat, state.world.harbor) <= state.world.harbor.radius && Math.abs(boat.speed) <= 5) {
    state.won = true;
    state.phase = "finished";
    state.ending = "harbor";
    state.score += Math.round(1200 + boat.hull * 8 + boat.fuel * 4 - state.elapsed * 2);
    state.message = "Лодка вошла в гавань. Все спасённые переданы береговой службе.";
    pushEvent(state, "win", state.message);
    events.push({type: "win"});
  }

  return events;
}

export function nearestSurvivor(state) {
  const candidates = state.world.survivors
    .filter(s => !s.rescued)
    .map(survivor => ({survivor, distance: dist(state.boat, survivor)}))
    .sort((a, b) => a.distance - b.distance);
  return candidates[0] || null;
}

export function getView(state) {
  const boat = state.boat;
  const nearest = nearestSurvivor(state);
  const harborDistance = dist(boat, state.world.harbor);
  let quickLabel = state.mode === "coop" && state.role === "captain" ? "Быстро сбросить ход" : "Импульс сонара";
  if (!(state.mode === "coop" && state.role === "captain") && nearest && nearest.distance <= CONFIG.rescueRadius + 3) quickLabel = "Подать спасательный трос";
  else if (!(state.mode === "coop" && state.role === "captain") && boat.water > 12) quickLabel = "Включить насос";
  return {
    phase: state.phase,
    mode: state.mode,
    role: state.role,
    message: state.message,
    elapsed: state.elapsed,
    remaining: Math.max(0, CONFIG.missionDuration - state.elapsed),
    rescued: state.rescued,
    score: state.score,
    won: state.won,
    lost: state.lost,
    ending: state.ending,
    boat: {
      heading: boat.heading,
      speed: boat.speed,
      throttle: boat.throttle,
      hull: boat.hull,
      water: boat.water,
      leak: boat.leak,
      fuel: boat.fuel,
      engineTemp: boat.engineTemp,
      engineStalled: boat.engineStalled,
      pumpActive: boat.pumpActive,
      repairProgress: boat.repairProgress,
    },
    sonar: {...state.sonar},
    nearestSurvivorDistance: nearest?.distance ?? null,
    harborDistance,
    quickLabel,
    canRepair: boat.engineStalled || boat.engineTemp >= 92,
    eventLog: state.eventLog.slice(-8),
  };
}

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : structuredClone(value);
  if (!parsed || parsed.version !== 1) throw new Error("Unsupported game state");
  return parsed;
}

function pushEvent(state, type, text, data = {}) {
  state.eventLog.push({time: Number(state.elapsed.toFixed(2)), type, text, data});
  state.eventLog = state.eventLog.slice(-40);
}
