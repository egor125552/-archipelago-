"use strict";

import {createGame, startGame, setControl, command, step, getView, serialize, deserialize} from "./game-core.js";
import {AudioEngine} from "./audio-engine.js";
import {LocalRoomTransport, PeerRoomTransport} from "./network.js";

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

function vibrate(pattern) { try { navigator.vibrate?.(pattern); } catch (_) {} }
function randomRoom() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

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
  window.speechSynthesis.speak(utterance);
}

function announceToReader(text) {
  const node = $("liveStatus");
  if (!node || !text) return;
  node.textContent = "";
  requestAnimationFrame(() => { node.textContent = text; });
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
    ? "Режим VoiceOver: фокус остаётся на выбранной кнопке; команды выполняются одним нажатием, встроенная речь выключена."
    : "Режим без VoiceOver: рулевые зоны и газ можно удерживать пальцем; игровые сообщения озвучивает Милена со скоростью 1,18.");
}

function newSession(mode, selectedRole = "captain") {
  role = selectedRole;
  stateBox.state = createGame({mode, role});
  lastMessage = "";
  renderCache.clear();
  render(true);
}

async function beginSolo() {
  await audio.init();
  transport?.close(); transport = null;
  newSession("solo", "captain");
  startGame(stateBox.state);
  showGame();
  render(true);
  startLoop();
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
    setNetworkStatus(`Не удалось войти: ${error.message}`);
    audio.play("deny", {gain: 0.55});
  }
}

function handleNetworkMessage(message) {
  if (!message || !stateBox.state) return;
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
      render(Boolean(events.length));
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

function render(forceAnnouncement = false) {
  if (!stateBox.state) return;
  const view = getView(stateBox.state);
  setText("speed", `${view.boat.speed.toFixed(1)} узла`);
  setText("heading", `${Math.round((view.boat.heading + 360) % 360)}°`);
  setText("hull", `${Math.round(view.boat.hull)}%`);
  setText("water", `${Math.round(view.boat.water)}%`);
  setText("fuel", `${Math.round(view.boat.fuel)}%`);
  setText("temperature", `${Math.round(view.boat.engineTemp)}°`);
  setText("rescued", `${view.rescued}/2`);
  setText("time", `${Math.ceil(view.remaining)} с`);
  setText("quickAction", view.quickLabel);

  const captainLocked = view.mode === "coop" && role === "crew";
  const crewLocked = view.mode === "coop" && role === "captain";
  for (const id of ["leftButton", "rightButton", "throttleButton", "reverseButton", "anchorButton"]) setAriaDisabled(id, captainLocked);
  for (const id of ["sonarButton", "pumpButton", "rescueButton"]) setAriaDisabled(id, crewLocked);
  setAriaDisabled("repairButton", crewLocked || !view.canRepair);
  $("pumpButton").classList.toggle("active", view.boat.pumpActive);
  setHidden("engineWarning", !view.boat.engineStalled && view.boat.engineTemp < 88);
  setText("engineWarning", view.boat.engineStalled ? "Двигатель заглох" : "Двигатель перегревается");
  setHidden("resultPanel", !(view.won || view.lost));
  if (view.won || view.lost) setText("resultText", `${view.message} Счёт: ${view.score}.`);

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
  return `${view.message} Скорость ${view.boat.speed.toFixed(1)} узла. Курс ${Math.round((view.boat.heading + 360) % 360)} градусов. Корпус ${Math.round(view.boat.hull)} процентов. Вода ${Math.round(view.boat.water)} процентов. Топливо ${Math.round(view.boat.fuel)} процентов. Спасено ${view.rescued} из двух. Осталось ${Math.ceil(view.remaining)} секунд.`;
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
$("quickAction").addEventListener("click", () => sendCommand("quick"));
$("repairButton").addEventListener("click", () => sendCommand("repair"));
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
setMode("touch");
window.__echoArchipelago = {
  getState: () => stateBox.state,
  setState: value => { stateBox.state = value; render(true); },
  command: sendCommand,
  control: sendControl,
  step: seconds => { const events = step(stateBox.state, seconds); audio.handle(events); render(Boolean(events.length)); return events; },
  startSolo: beginSolo,
  resetOperation,
  getView: () => stateBox.state && getView(stateBox.state),
  setMode,
  speechRate: SPEECH_RATE,
};
