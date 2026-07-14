"use strict";

import {createGame, startGame, setControl, command, step, getView, serialize, deserialize} from "./game-core.js";
import {AudioEngine} from "./audio-engine.js";
import {LocalRoomTransport, PeerRoomTransport} from "./network.js";
import {
  BOATS,
  OPERATIONS,
  SHOP_ITEMS,
  loadProfile,
  purchaseUpgrade,
  recordOperation,
  runLoadout,
  saveProfile,
  selectBoat,
  selectOperation,
} from "./progression.js?v=25.0";

const $ = id => document.getElementById(id);
const stateBox = {state: null};
const SPEECH_RATE = 1.18;
const renderCache = new Map();
let audio = new AudioEngine();
let raf = 0;
let previousTime = 0;
let lastUiRender = 0;
let transport = null;
let accessibilityMode = "touch";
let role = "captain";
let roomCode = "";
let lastMessage = "";
let speechEnabled = true;
let selectedVoice = null;
let profile = loadProfile();
let recordedResultState = null;
let readerAnnouncementVersion = 0;
let readerAnnouncementClearTimer = 0;
let soloStarting = false;

function vibrate(pattern) { try { navigator.vibrate?.(pattern); } catch (_) {} }
function randomRoom() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

function resumeGameAudio() {
  const context = audio?.ctx;
  if (!context || context.state !== "suspended") return;
  context.resume().catch(() => {});
}

function setText(id, value) {
  const text = String(value ?? "");
  if (renderCache.get(`text:${id}`) === text) return;
  renderCache.set(`text:${id}`, text);
  const node = $(id);
  if (node) node.textContent = text;
}

function setHidden(id, hidden) {
  const value = Boolean(hidden);
  if (renderCache.get(`hidden:${id}`) === value) return;
  renderCache.set(`hidden:${id}`, value);
  const node = $(id);
  if (node) node.hidden = value;
}

function setAriaDisabled(id, disabled) {
  const value = String(Boolean(disabled));
  if (renderCache.get(`aria-disabled:${id}`) === value) return;
  renderCache.set(`aria-disabled:${id}`, value);
  const node = $(id);
  if (node) node.setAttribute("aria-disabled", value);
}

function normalize(value) { return String(value || "").toLowerCase().replace(/ё/g, "е"); }

function voiceScore(voice) {
  if (!normalize(voice?.lang).startsWith("ru")) return -10000;
  const name = normalize(`${voice.name} ${voice.voiceURI}`);
  let score = 10;
  if (/milena|милена/.test(name)) score += 1000;
  if (/enhanced|premium|improved|natural|neural|улучш/.test(name)) score += 500;
  if (/compact|компакт/.test(name)) score -= 200;
  return score;
}

function refreshVoice() {
  if (!("speechSynthesis" in window)) return null;
  selectedVoice = [...window.speechSynthesis.getVoices()].sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
  return selectedVoice;
}

function speak(text, force = false) {
  if (!text || !("speechSynthesis" in window)) return;
  if (!force && (!speechEnabled || accessibilityMode === "reader")) return;
  refreshVoice();
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ru-RU";
  utterance.rate = SPEECH_RATE;
  utterance.pitch = 1;
  if (selectedVoice) utterance.voice = selectedVoice;
  utterance.onend = resumeGameAudio;
  utterance.onerror = resumeGameAudio;
  window.speechSynthesis.speak(utterance);
}

function announceToReader(text) {
  const node = $("liveStatus");
  if (!node || !text) return;
  const version = ++readerAnnouncementVersion;
  clearTimeout(readerAnnouncementClearTimer);
  node.textContent = "";
  requestAnimationFrame(() => {
    if (version !== readerAnnouncementVersion) return;
    node.textContent = text;
    readerAnnouncementClearTimer = setTimeout(() => {
      if (version === readerAnnouncementVersion && node.textContent === text) node.textContent = "";
    }, 6000);
  });
}

function setMode(mode) {
  accessibilityMode = mode;
  document.body.dataset.accessibility = mode;
  $("modeTouch").setAttribute("aria-pressed", String(mode === "touch"));
  $("modeReader").setAttribute("aria-pressed", String(mode === "reader"));
  speechEnabled = mode !== "reader";
  setText("speechButton", `Игровая озвучка: ${speechEnabled ? "включена" : "выключена"}`);
  $("speechButton").setAttribute("aria-pressed", String(speechEnabled));
  setText("modeHint", mode === "reader"
    ? "VoiceOver: команды одним нажатием. Встроенная речь выключена."
    : "Обычный режим: руль и газ можно удерживать пальцем.");
}

function persistProfile(next) {
  profile = saveProfile(next);
  renderProgressionMenu();
  return profile;
}

function setProgressionStatus(text, announce = false) {
  setText("progressionStatus", text);
  if (announce) {
    announceToReader(text);
    speak(text);
  }
}

function renderProgressionMenu() {
  const records = OPERATIONS.map(operation => `уровень ${operation.id}: ${profile.bestByLevel?.[operation.id] || 0}`).join(", ");
  setText("profileSummary", `Жетоны: ${profile.credits}. Победы: ${profile.wins} из ${profile.runs}. Лучший счёт: ${profile.bestScore}. Рекорды — ${records}.`);
  for (const operation of OPERATIONS) {
    const button = $(`operation${operation.id}`);
    if (!button) continue;
    const unlocked = operation.id <= profile.unlockedLevel;
    const selected = operation.id === profile.selectedLevel;
    button.disabled = !unlocked;
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = unlocked
      ? `Уровень ${operation.id} — ${operation.name}${selected ? " — выбран" : ""}`
      : `Уровень ${operation.id} — закрыт`;
  }
  const operation = OPERATIONS.find(item => item.id === profile.selectedLevel) || OPERATIONS[0];
  setText("operationDescription", operation.description);

  for (const boat of BOATS) {
    const id = {
      strizh: "boatStrizh",
      kasatka: "boatKasatka",
      burevestnik: "boatBurevestnik",
      grom: "boatGrom",
    }[boat.id];
    const button = $(id);
    if (!button) continue;
    const unlocked = boat.unlockLevel <= profile.unlockedLevel;
    const selected = boat.id === profile.selectedBoat;
    button.disabled = !unlocked;
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = unlocked
      ? `${boat.name}${selected ? " — выбран" : ""}`
      : `${boat.name} — откроется на уровне ${boat.unlockLevel}`;
  }
  const boat = BOATS.find(item => item.id === profile.selectedBoat) || BOATS[0];
  setText("boatDescription", boat.description);

  setHidden("shopPanel", profile.unlockedLevel < 2);
  const itemButtons = {
    "coast-brake": "buyCoastBrake",
    "mini-armor": "buyMiniArmor",
    "high-flow-pump": "buyHighFlowPump",
    "ram-keel": "buyRamKeel",
    "debris-tools": "buyDebrisTools",
  };
  for (const item of SHOP_ITEMS) {
    const button = $(itemButtons[item.id]);
    if (!button) continue;
    const owned = profile.ownedUpgrades.includes(item.id);
    const locked = profile.unlockedLevel < item.unlockLevel;
    button.disabled = owned || locked || profile.credits < item.cost;
    button.textContent = owned
      ? `${item.name} — куплено. ${item.description}`
      : `${item.name} — ${item.cost} жетонов. ${item.description}`;
  }
}

function chooseOperation(level) {
  if (level > profile.unlockedLevel) {
    setProgressionStatus(`Уровень ${level} пока закрыт. Заверши предыдущую операцию.`, true);
    return;
  }
  persistProfile(selectOperation(profile, level));
  const operation = OPERATIONS.find(item => item.id === profile.selectedLevel);
  setProgressionStatus(`Выбран уровень ${operation.id}: ${operation.name}.`, true);
}

function chooseBoat(boatId) {
  const boat = BOATS.find(item => item.id === boatId);
  if (!boat || boat.unlockLevel > profile.unlockedLevel) {
    setProgressionStatus(boat ? `${boat.name} откроется на уровне ${boat.unlockLevel}.` : "Лодка недоступна.", true);
    return;
  }
  persistProfile(selectBoat(profile, boatId));
  setProgressionStatus(`Выбран ${boat.name}.`, true);
}

function buyUpgrade(itemId) {
  const result = purchaseUpgrade(profile, itemId);
  if (!result.ok) {
    const text = result.reason === "credits"
      ? `Недостаточно жетонов для покупки «${result.item.name}». Нужно ${result.item.cost}, сейчас ${profile.credits}.`
      : result.reason === "owned"
        ? `${result.item.name} уже куплен.`
        : "Это улучшение пока закрыто.";
    setProgressionStatus(text, true);
    return;
  }
  persistProfile(result.profile);
  setProgressionStatus(`${result.item.name} куплен. Осталось ${profile.credits} жетонов.`, true);
  audio.play("repair", {gain: 0.5, rate: 1.08});
}

function recordFinishedOperation(view) {
  if (!stateBox.state || recordedResultState === stateBox.state || view.mode !== "solo" || !(view.won || view.lost)) return;
  recordedResultState = stateBox.state;
  const reward = view.won ? Number(view.progression?.rewardCredits) || 0 : 0;
  persistProfile(recordOperation(profile, {
    level: view.progression?.level || 1,
    won: view.won,
    reward,
    score: view.score,
  }));
}

function newSession(mode, selectedRole = "captain") {
  role = selectedRole;
  const progression = mode === "solo"
    ? runLoadout(profile)
    : {level: 1, boatId: "strizh", upgrades: {}};
  stateBox.state = createGame({mode, role, progression});
  recordedResultState = null;
  lastMessage = "";
  renderCache.clear();
  render(true);
}

async function beginSolo() {
  if (soloStarting) return;
  soloStarting = true;
  const startButton = $("soloButton");
  startButton.disabled = true;
  startButton.setAttribute("aria-busy", "true");
  setText("soloButton", "Запускаю операцию…");
  $("startScreen").setAttribute("aria-busy", "true");
  setProgressionStatus("Запускаю операцию: подготавливаю звук и игровую сцену…", true);
  try {
    try {
      await audio.init();
    } catch (_) {
      setProgressionStatus("Звук не подготовился, но операция запускается без задержки.", true);
    }
    transport?.close(); transport = null;
    newSession("solo", "captain");
    startGame(stateBox.state);
    showGame();
    render(true);
    startLoop();
  } finally {
    soloStarting = false;
    startButton.disabled = false;
    startButton.removeAttribute("aria-busy");
    setText("soloButton", "Начать одиночную спасательную операцию");
    $("startScreen").removeAttribute("aria-busy");
  }
}

async function hostCoop(kind) {
  await audio.init();
  roomCode = ($("roomInput").value.trim() || randomRoom()).toUpperCase();
  $("roomInput").value = roomCode;
  newSession("coop", "captain");
  transport = kind === "peer" ? new PeerRoomTransport(roomCode, "captain") : new LocalRoomTransport(roomCode, "captain");
  setNetworkStatus(`Комната ${roomCode}: ждём второго игрока…`);
  transport.onMessage(handleNetworkMessage);
  try {
    await transport.connect();
    startGame(stateBox.state);
    transport.send({type: "snapshot", state: serialize(stateBox.state)});
    setNetworkStatus(`Комната ${roomCode}: капитан подключён.`);
    showGame(); render(true); startLoop();
  } catch (error) {
    transport?.close();
    transport = null;
    setNetworkStatus(`Не удалось открыть комнату: ${error.message}`);
    audio.play("deny", {gain: 0.55});
  }
}

async function joinCoop(kind) {
  await audio.init();
  roomCode = $("roomInput").value.trim().toUpperCase();
  if (!roomCode) {
    setNetworkStatus("Введи код комнаты.");
    audio.play("deny", {gain: 0.55});
    return;
  }
  newSession("coop", "crew");
  transport = kind === "peer" ? new PeerRoomTransport(roomCode, "crew") : new LocalRoomTransport(roomCode, "crew");
  transport.onMessage(handleNetworkMessage);
  try {
    await transport.connect();
    transport.send({type: "hello", role: "crew"});
    setNetworkStatus(`Комната ${roomCode}: второй игрок подключён.`);
    showGame(); render(true); startLoop();
  } catch (error) {
    transport?.close();
    transport = null;
    setNetworkStatus(`Не удалось войти: ${error.message}`);
    audio.play("deny", {gain: 0.55});
  }
}

function handleNetworkMessage(message) {
  if (!message || !stateBox.state) return;
  if (message.type === "network-error" || message.type === "network-closed") {
    if (role === "captain") {
      for (const control of ["pump", "rescue", "hullRepair"]) {
        setControl(stateBox.state, control, false, "crew");
      }
    }
    const text = message.type === "network-error"
      ? `Ошибка связи с напарником: ${message.message || "соединение потеряно"}. Активные системы оператора безопасно выключены.`
      : "Связь с напарником закрыта. Активные системы оператора безопасно выключены; операцию можно перезапустить с карты.";
    stateBox.state.message = text;
    setNetworkStatus(text);
    audio.play("deny", {gain: 0.55});
    vibrate([40, 45, 40]);
    render(true);
    return;
  }
  if (role === "captain") {
    if (message.type === "control") setControl(stateBox.state, message.control, message.active, "crew");
    if (message.type === "command") {
      const result = command(stateBox.state, message.action, "crew");
      audio.handle(result.events);
      render(true);
    }
    if (message.type === "hello") {
      setNetworkStatus(`Комната ${roomCode}: экипаж в сборе.`);
      transport.send({type: "snapshot", state: serialize(stateBox.state)});
    }
  } else if (message.type === "snapshot") {
    stateBox.state = deserialize(message.state);
    stateBox.state.role = "crew";
    render();
  }
}

function showGame() {
  $("startScreen").hidden = true;
  $("gameScreen").hidden = false;
  setText("roleLabel", role === "captain" ? "Капитан" : "Системный оператор");
  document.body.dataset.role = role;
  requestAnimationFrame(() => $("gameTitle").focus({preventScroll: true}));
}

function startLoop() {
  cancelAnimationFrame(raf);
  previousTime = performance.now();
  lastUiRender = 0;
  const frame = now => {
    const dt = Math.min(0.1, (now - previousTime) / 1000);
    previousTime = now;
    let events = [];
    if (stateBox.state?.phase === "playing" && role === "captain") {
      events = step(stateBox.state, dt);
      audio.handle(events);
      if (transport && Math.floor(now / 100) !== Math.floor((now - dt * 1000) / 100)) {
        transport.send({type: "snapshot", state: serialize(stateBox.state)});
      }
    }
    if (events.length || now - lastUiRender >= 200) {
      lastUiRender = now;
      render();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

function render(forceAnnouncement = false) {
  if (!stateBox.state) return;
  const view = getView(stateBox.state);
  recordFinishedOperation(view);
  setText("operationLevel", `${view.progression?.level || 1}`);
  setText("boatName", (view.boat.modelName || "Катер «Стриж»").replace("Катер ", ""));
  setText("armor", view.boat.armorMax > 0 ? `${Math.ceil(view.boat.armor)}/${Math.ceil(view.boat.armorMax)}` : "нет");
  setText("speed", `${view.boat.speed.toFixed(1)} узла`);
  setText("heading", `${Math.round((view.boat.heading + 360) % 360)}°`);
  setText("hull", `${Math.round(view.boat.hull)}%`);
  setText("water", `${Math.round(view.boat.water)}%`);
  setText("fuel", `${Math.round(view.boat.fuel)}%`);
  setText("temperature", `${Math.round(view.boat.engineTemp)}°`);
  setText("rescued", `${view.rescued}/2`);
  setText("debrisCount", `${view.debris?.count || 0}`);
  setText("time", view.timed ? `${Math.ceil(view.remaining)} с` : "Без лимита");
  const risk = view.riskRoute;
  setText("riskRouteState", !risk?.available
    ? "обычный; риск закрыт до уровня 2"
    : risk.active
      ? risk.selectionPending ? "риск; смена ждёт сонар" : "рискованный"
      : risk.selectionPending
        ? `${risk.selectedRisk ? "риск" : "обычный"} выбран`
        : risk.enabled ? "рискованный" : "обычный");
  const captainLocked = view.mode === "coop" && role === "crew";
  const crewLocked = view.mode === "coop" && role === "captain";
  setText("quickAction", view.quickLabel);
  setHidden("debrisButton", !view.debris?.count && !view.debris?.removing);
  setAriaDisabled("debrisButton", crewLocked || !view.debris?.canRemove);
  const debrisButton = $("debrisButton");
  if (debrisButton) {
    debrisButton.classList.toggle("active", Boolean(view.debris?.removing));
    debrisButton.setAttribute("aria-pressed", String(Boolean(view.debris?.removing)));
    setText("debrisButton", view.debris?.removing
      ? `Извлечение ${Math.round(view.debris.progress)}% — отменить`
      : `Извлечь обломок — ${view.debris?.count || 0}`);
  }
  const refuelButton = $("refuelButton");
  if (refuelButton && view.refuel) {
    setAriaDisabled("refuelButton", crewLocked || (!view.refuel.canStart && !view.refuel.active));
    refuelButton.setAttribute("aria-pressed", String(Boolean(view.refuel.active)));
    setText("refuelButton", view.refuel.active
      ? `Заправка ${Math.round(view.refuel.progress)}% — отменить`
      : view.refuel.atHarbor
        ? "Заправиться в гавани"
        : `Аварийная канистра — ${view.refuel.canisters}`);
  }
  const anchorButton = $("anchorButton");
  if (anchorButton && view.floatingBrake) {
    setAriaDisabled("anchorButton", captainLocked || !view.floatingBrake.ready);
    setText("anchorButton", view.floatingBrake.ready
      ? "Сбросить плавучий тормоз"
      : `Плавучий тормоз — восстановление ${Math.ceil(view.floatingBrake.remaining)} с`);
  }
  setHidden("decoyButton", !view.hunter?.enabled || view.hunter?.destroyed);
  setAriaDisabled("decoyButton", crewLocked || !view.hunter?.decoyCharges || view.hunter?.destroyed);
  setText("decoyButton", `Ложный буй — ${view.hunter?.decoyCharges || 0}`);
  setHidden("hunterStatus", !view.hunter?.enabled);
  setText("hunterStatus", view.hunter?.destroyed
    ? "Преследователь выведен из строя"
    : !view.hunter?.active
      ? `Преследователь появится через ${Math.ceil(view.hunter?.arrivesIn || 0)} с`
      : `Преследователь: ${Math.round(view.hunter.distance)} м, ${view.hunter.relativeAngle < -12 ? "слева" : view.hunter.relativeAngle > 12 ? "справа" : "прямо"}; корпус ${Math.round(view.hunter.hull)}%; ${view.hunter.modeLabel}`);

  for (const id of ["leftButton", "rightButton", "throttleButton", "reverseButton"]) setAriaDisabled(id, captainLocked);
  for (const id of ["sonarButton", "pumpButton", "rescueButton"]) setAriaDisabled(id, crewLocked);
  setAriaDisabled("pumpAssistButton", !view.pumpAssist?.available);
  setAriaDisabled("repairButton", crewLocked || (!view.canRepair && !view.waterEngine?.canRestart));
  setAriaDisabled("routeModeButton", !risk?.available || crewLocked);
  const routeButton = $("routeModeButton");
  if (routeButton) {
    routeButton.setAttribute("aria-pressed", String(Boolean(risk?.selectedRisk)));
    setText("routeModeButton", !risk?.available
      ? "МАРШРУТ: ОБЫЧНЫЙ — риск откроется на уровне 2"
      : risk.selectedRisk
        ? `МАРШРУТ: РИСКОВАННЫЙ${risk.selectionPending ? " — НАЖМИ СОНАР" : ""}`
        : `МАРШРУТ: ОБЫЧНЫЙ${risk.selectionPending ? " — НАЖМИ СОНАР" : ""}`);
  }
  $("pumpButton").classList.toggle("active", view.boat.pumpActive);
  setHidden("engineWarning", !view.waterEngine?.locked && !view.boat.engineStalled && view.boat.engineTemp < 88);
  let engineText = "Мотор перегревается";
  if (view.refuel?.active) engineText = "Мотор остановлен — идёт заправка";
  else if (view.engineService?.active) engineText = "Мотор обслуживается";
  else if (view.waterEngine?.locked) {
    if (view.waterEngine.canRestart) engineText = "Мотор готов к запуску";
    else if (view.damageControl?.floodEmergency) engineText = "Мотор остановлен — стабилизируй лодку";
    else if (view.boat.water > view.waterEngine.restartWater) engineText = `Мотор залит — откачай до ${view.waterEngine.restartWater}%`;
    else if (view.boat.fuel <= 0.01) engineText = "Нет топлива";
    else engineText = "Мотор перегрет — обслужи его";
  } else if (view.boat.engineStalled) engineText = "Мотор заглох";
  setText("engineWarning", engineText);
  setHidden("resultPanel", !(view.won || view.lost));
  if (view.won || view.lost) {
    setText("resultText", `${view.message} Счёт: ${view.score}.`);
    setText("rewardText", view.won
      ? `Получено ${view.progression?.rewardCredits || 0} жетонов. Всего: ${profile.credits}.`
      : "За незавершённую операцию жетоны не начисляются.");
  }

  if (view.message !== lastMessage || forceAnnouncement) {
    lastMessage = view.message;
    setText("missionMessage", view.message);
    announceToReader(view.message);
    speak(view.message);
  }
  audio.update(view);
}

function fullStatus() {
  if (!stateBox.state) return "Операция ещё не запущена.";
  const view = getView(stateBox.state);
  if (view.damageControl?.floodEmergency) {
    return `Авария: ${Math.ceil(view.damageControl.floodEmergencyRemaining)} секунд. Вода ${Math.round(view.boat.water)}, нужно ${view.damageControl.recoveryWaterTarget}. Корпус ${Math.round(view.boat.hull)}, нужно ${view.damageControl.recoveryHullTarget}. Насос ${view.boat.pumpActive ? "включён" : "выключен"}.`;
  }
  const motorStopped = Boolean(view.waterEngine?.locked || view.boat.engineStalled);
  const parts = [
    `Скорость ${view.boat.speed.toFixed(1)}.`,
    `Корпус ${Math.round(view.boat.hull)}.`,
    `Вода ${Math.round(view.boat.water)}.`,
    `Топливо ${Math.round(view.boat.fuel)}.`,
    `Спасено ${view.rescued} из 2.`,
  ];
  if (motorStopped) parts.unshift("Мотор остановлен.");
  else parts.splice(1, 0, `Курс ${Math.round((view.boat.heading + 360) % 360)}.`);
  if (view.debris?.count) parts.push(`Обломков в корпусе: ${view.debris.count}.`);
  if (view.refuel?.active) parts.push(`Заправка ${Math.round(view.refuel.progress)} процентов.`);
  else if (view.refuel) parts.push(`Аварийных канистр: ${view.refuel.canisters}.`);
  if (view.hunter?.active) parts.push(`Преследователь ${Math.round(view.hunter.distance)} метров. Корпус ${Math.round(view.hunter.hull)}. ${view.hunter.modeLabel}.`);
  else if (view.hunter?.destroyed) parts.push("Преследователь выведен из строя.");
  if (view.timed) parts.push(`Время ${Math.ceil(view.remaining)} секунд.`);
  return parts.join(" ");
}

function localFeedback(text) {
  setText("missionMessage", text);
  announceToReader(text);
  speak(text);
  audio.play("deny", {gain: 0.55});
  vibrate([30, 35, 30]);
}

function controlAllowed(control) {
  const captainControls = new Set(["left", "right", "forward", "reverse", "anchor"]);
  const crewControls = new Set(["pump", "rescue", "sonar", "repair"]);
  if (stateBox.state?.mode !== "coop") return true;
  if (role === "crew" && captainControls.has(control)) return false;
  if (role === "captain" && crewControls.has(control)) return false;
  return true;
}

function sendControl(control, active) {
  if (!stateBox.state) return false;
  if (!controlAllowed(control)) {
    if (active) localFeedback(role === "captain" ? "Эта система находится у второго игрока." : "Управление ходом находится у капитана.");
    return false;
  }
  if (role === "captain") return setControl(stateBox.state, control, active, "captain");
  transport?.send({type: "control", control, active});
  return true;
}

function sendCommand(action) {
  if (!stateBox.state) return;
  if (role === "captain") {
    const result = command(stateBox.state, action, "captain");
    audio.handle(result.events);
    if (action === "quick" && result.ok) vibrate(18);
    render(true);
  } else {
    transport?.send({type: "command", action});
  }
}

function bindHold(id, control) {
  const button = $(id);
  let active = false;
  const down = event => {
    if (accessibilityMode === "reader") return;
    event.preventDefault();
    if (!sendControl(control, true)) return;
    active = true;
    button.classList.add("held");
    vibrate(8);
  };
  const up = event => {
    if (!active) return;
    event?.preventDefault();
    active = false;
    sendControl(control, false);
    button.classList.remove("held");
  };
  button.addEventListener("pointerdown", down);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  button.addEventListener("pointerleave", up);
  button.addEventListener("click", event => {
    if (accessibilityMode !== "reader") return;
    event.preventDefault();
    if (!sendControl(control, true)) return;
    button.classList.add("held");
    setTimeout(() => {
      sendControl(control, false);
      button.classList.remove("held");
    }, 480);
  });
}

function setNetworkStatus(text) {
  setText("networkStatus", text);
  if (/не удалось|введи/i.test(text)) audio.play("deny", {gain: 0.55});
}

function resetOperation() {
  cancelAnimationFrame(raf);
  raf = 0;
  transport?.close();
  transport = null;
  audio.stopAll();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  stateBox.state = null;
  lastMessage = "";
  renderCache.clear();
  $("gameScreen").hidden = true;
  $("startScreen").hidden = false;
  $("resultPanel").hidden = true;
  $("engineWarning").hidden = true;
  setNetworkStatus("Локальная комната работает между двумя вкладками. Интернет-комната использует WebRTC.");
  renderProgressionMenu();
  requestAnimationFrame(() => $("soloButton").focus({preventScroll: true}));
}

$("modeTouch").addEventListener("click", () => setMode("touch"));
$("modeReader").addEventListener("click", () => setMode("reader"));
$("soloButton").addEventListener("click", beginSolo);
$("hostLocal").addEventListener("click", () => hostCoop("local"));
$("joinLocal").addEventListener("click", () => joinCoop("local"));
$("hostPeer").addEventListener("click", () => hostCoop("peer"));
$("joinPeer").addEventListener("click", () => joinCoop("peer"));
$("sonarButton").addEventListener("click", () => sendCommand("sonar"));
$("routeModeButton").addEventListener("click", () => sendCommand("risk-route-toggle"));
$("quickAction").addEventListener("click", () => sendCommand("quick"));
$("repairButton").addEventListener("click", () => sendCommand("repair"));
$("debrisButton").addEventListener("click", () => sendCommand("debris-remove"));
$("refuelButton").addEventListener("click", () => sendCommand("refuel"));
$("decoyButton").addEventListener("click", () => sendCommand("hunter-decoy"));
$("pumpAssistButton").addEventListener("click", () => sendCommand("pump-assist-toggle"));
$("anchorButton").addEventListener("click", () => sendCommand("anchor"));
$("statusButton").addEventListener("click", () => {
  const text = fullStatus();
  announceToReader(text);
  speak(text, accessibilityMode !== "reader");
});
$("speechButton").addEventListener("click", () => {
  speechEnabled = !speechEnabled;
  $("speechButton").setAttribute("aria-pressed", String(speechEnabled));
  setText("speechButton", `Игровая озвучка: ${speechEnabled ? "включена" : "выключена"}`);
  if (!speechEnabled && "speechSynthesis" in window) window.speechSynthesis.cancel();
  else speak("Игровая озвучка включена. Скорость один целых восемнадцать сотых.", true);
});
$("soundButton").addEventListener("click", () => {
  audio.setEnabled(!audio.enabled);
  setText("soundButton", `Звук: ${audio.enabled ? "включён" : "выключен"}`);
});
$("restartButton").addEventListener("click", resetOperation);
$("operation1").addEventListener("click", () => chooseOperation(1));
$("operation2").addEventListener("click", () => chooseOperation(2));
$("operation3").addEventListener("click", () => chooseOperation(3));
$("operation4").addEventListener("click", () => chooseOperation(4));
$("operation5").addEventListener("click", () => chooseOperation(5));
$("operation6").addEventListener("click", () => chooseOperation(6));
$("boatStrizh").addEventListener("click", () => chooseBoat("strizh"));
$("boatKasatka").addEventListener("click", () => chooseBoat("kasatka"));
$("boatBurevestnik").addEventListener("click", () => chooseBoat("burevestnik"));
$("boatGrom").addEventListener("click", () => chooseBoat("grom"));
$("buyCoastBrake").addEventListener("click", () => buyUpgrade("coast-brake"));
$("buyMiniArmor").addEventListener("click", () => buyUpgrade("mini-armor"));
$("buyHighFlowPump").addEventListener("click", () => buyUpgrade("high-flow-pump"));
$("buyRamKeel").addEventListener("click", () => buyUpgrade("ram-keel"));
$("buyDebrisTools").addEventListener("click", () => buyUpgrade("debris-tools"));

bindHold("leftButton", "left");
bindHold("rightButton", "right");
bindHold("throttleButton", "forward");
bindHold("reverseButton", "reverse");
bindHold("pumpButton", "pump");
bindHold("rescueButton", "rescue");

window.addEventListener("keydown", event => {
  if (!stateBox.state) return;
  if (event.key === "ArrowLeft") sendControl("left", true);
  if (event.key === "ArrowRight") sendControl("right", true);
  if (event.key === "ArrowUp") sendControl("forward", true);
  if (event.key === "ArrowDown") sendControl("reverse", true);
  if (event.key.toLowerCase() === "s") sendCommand("sonar");
  if (event.key === " ") { event.preventDefault(); sendCommand("quick"); }
  if (event.key.toLowerCase() === "p") sendControl("pump", true);
  if (event.key.toLowerCase() === "r") sendControl("rescue", true);
});
window.addEventListener("keyup", event => {
  if (event.key === "ArrowLeft") sendControl("left", false);
  if (event.key === "ArrowRight") sendControl("right", false);
  if (event.key === "ArrowUp") sendControl("forward", false);
  if (event.key === "ArrowDown") sendControl("reverse", false);
  if (event.key.toLowerCase() === "p") sendControl("pump", false);
  if (event.key.toLowerCase() === "r") sendControl("rescue", false);
});

if ("speechSynthesis" in window) {
  refreshVoice();
  window.speechSynthesis.onvoiceschanged = refreshVoice;
}
window.addEventListener("focus", resumeGameAudio, {passive: true});
window.addEventListener("pageshow", resumeGameAudio, {passive: true});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) resumeGameAudio();
}, {passive: true});
setMode("touch");
renderProgressionMenu();
window.__echoArchipelago = {
  getState: () => stateBox.state,
  setState: value => { stateBox.state = value; render(true); },
  command: sendCommand,
  control: sendControl,
  step: seconds => { const events = step(stateBox.state, seconds); audio.handle(events); render(); return events; },
  startSolo: beginSolo,
  resetOperation,
  getView: () => stateBox.state && getView(stateBox.state),
  announce: text => { announceToReader(text); speak(text); },
  setMode,
  speechRate: SPEECH_RATE,
};
