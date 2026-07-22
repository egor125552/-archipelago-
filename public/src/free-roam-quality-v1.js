"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=38";
import {predictLocalWorld} from "./free-roam-client-prediction.js?v=40";
import {
  AUDIO_INTERVAL_MS,
  createChangeGate,
  isPredictionFrame,
} from "./free-roam-runtime-model.js?v=1";

const $ = id => document.getElementById(id);
const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
const textContentDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
const pendingAudioWorlds = new Map();
const runtimeStats = {
  predictionSteps: 0,
  audioUpdates: 0,
  committedTextWrites: 0,
  skippedTextWrites: 0,
  committedAttributeWrites: 0,
  skippedAttributeWrites: 0,
};

const changeOnlyIds = [
  "roomLabel", "message",
  "modeValue", "speedValue", "hullValue", "waterValue", "towValue", "otherValue",
  "healthValue", "weaponValue", "targetValue", "cargoValue", "scoreValue",
  "scenarioValue", "marauderValue", "networkValue",
  "controlModeButton", "speechButton", "actionButton", "jumpButton", "attackButton",
  "weaponButton", "targetButton", "sonarButton", "guideButton", "pumpButton", "repairButton",
];

function installChangeOnlyText(node, transform = value => String(value ?? "")) {
  if (!node || node.dataset.changeOnlyText === "true" || !textContentDescriptor?.get || !textContentDescriptor?.set) return;
  const gate = createChangeGate(textContentDescriptor.get.call(node));
  Object.defineProperty(node, "textContent", {
    configurable: true,
    enumerable: true,
    get() {
      return textContentDescriptor.get.call(this);
    },
    set(value) {
      const next = transform(value);
      if (!gate.shouldCommit(next)) {
        runtimeStats.skippedTextWrites += 1;
        return;
      }
      runtimeStats.committedTextWrites += 1;
      textContentDescriptor.set.call(this, next);
    },
  });
  node.dataset.changeOnlyText = "true";

  const nativeSetAttribute = node.setAttribute.bind(node);
  node.setAttribute = (name, value) => {
    const next = String(value);
    if (node.getAttribute(name) === next) {
      runtimeStats.skippedAttributeWrites += 1;
      return;
    }
    runtimeStats.committedAttributeWrites += 1;
    nativeSetAttribute(name, next);
  };
}

for (const id of changeOnlyIds) {
  const node = $(id);
  installChangeOnlyText(
    node,
    id === "guideButton" ? () => "Повернуть к сонару" : value => String(value ?? ""),
  );
}

const guideButton = $("guideButton");
if (guideButton) {
  const nativeSetAttribute = guideButton.setAttribute.bind(guideButton);
  guideButton.setAttribute = (name, value) => {
    if (name === "aria-pressed") return;
    if (guideButton.getAttribute(name) === String(value)) {
      runtimeStats.skippedAttributeWrites += 1;
      return;
    }
    runtimeStats.committedAttributeWrites += 1;
    nativeSetAttribute(name, String(value));
  };
  guideButton.removeAttribute("aria-pressed");
  guideButton.setAttribute("aria-label", "Один раз повернуть лодку прямо к текущей цели сонара");
}

const nullCanvasContext = {
  clearRect() {}, fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
  beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
};
const map = $("map");
if (map) {
  map.hidden = true;
  map.width = 0;
  map.height = 0;
  map.dataset.rendering = "disabled";
  map.getContext = () => nullCanvasContext;
}

document.body.classList.add("audio-only-map");

const originalAudioUpdateWorld = FreeRoamAudio.prototype.updateWorld;
FreeRoamAudio.prototype.updateWorld = function queueAudioWorld(world, playerIndex) {
  pendingAudioWorlds.set(this, {world, playerIndex});
};

const originalAudioStopAll = FreeRoamAudio.prototype.stopAll;
if (typeof originalAudioStopAll === "function") {
  FreeRoamAudio.prototype.stopAll = function stopSeparatedAudio(...args) {
    pendingAudioWorlds.delete(this);
    return originalAudioStopAll.apply(this, args);
  };
}

setInterval(() => {
  if (document.hidden || $("game")?.hidden) return;
  for (const [instance, state] of pendingAudioWorlds) {
    if (!state.world) continue;
    originalAudioUpdateWorld.call(instance, state.world, state.playerIndex);
    runtimeStats.audioUpdates += 1;
  }
}, AUDIO_INTERVAL_MS);

let predictionFrameId = 0;
let previousPredictionAt = 0;

function separatedPredictionFrame(now) {
  const api = globalThis.__freeRoam;
  const game = $("game");
  if (api && game && !game.hidden) {
    const dt = Math.min(0.1, Math.max(0, (now - previousPredictionAt) / 1000));
    previousPredictionAt = now;
    const currentWorld = api.getWorld?.();
    if (currentWorld) {
      predictLocalWorld(currentWorld, api.playerIndex(), api.input, dt);
      runtimeStats.predictionSteps += 1;
    }
  } else {
    previousPredictionAt = now;
  }
  predictionFrameId = nativeRequestAnimationFrame(separatedPredictionFrame);
}

window.requestAnimationFrame = function requestAnimationFrame(callback) {
  if (!isPredictionFrame(callback)) return nativeRequestAnimationFrame(callback);
  if (!predictionFrameId) {
    previousPredictionAt = performance.now();
    predictionFrameId = nativeRequestAnimationFrame(separatedPredictionFrame);
  }
  return predictionFrameId;
};

globalThis.__freeRoamRuntime = {
  mapRendering: false,
  audioIntervalMs: AUDIO_INTERVAL_MS,
  stats: runtimeStats,
  pendingAudioCount: () => pendingAudioWorlds.size,
};
