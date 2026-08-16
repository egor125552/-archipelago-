"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=43";
import {COMBAT_TUNING} from "./free-roam-combat-tuning.js?v=34";

const STORAGE_KEY = "echo-free-roam-combat-guidance-v1";
const EXPERIENCED = Object.freeze({
  profile: "experienced",
  death: false,
  threat: true,
  aim: true,
  playerHit: false,
  boatHit: true,
  repair: true,
  combatStatus: false,
});
const BEGINNER = Object.freeze({
  profile: "beginner",
  death: true,
  threat: true,
  aim: true,
  playerHit: true,
  boatHit: true,
  repair: true,
  combatStatus: true,
});
const LABELS = Object.freeze({
  death: "Смерть и возрождение",
  threat: "Уровень угрозы и прибытие врагов",
  aim: "Наведение и подготовка атаки",
  playerHit: "Попадания по игроку и здоровье",
  boatHit: "Попадания по лодке и корпус",
  repair: "Отход и ремонт тяжёлого катера",
  combatStatus: "Подробности каждого попадания",
});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function loadPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored || typeof stored !== "object") return {...EXPERIENCED};
    return {
      profile: ["beginner", "experienced", "custom"].includes(stored.profile) ? stored.profile : "custom",
      ...Object.fromEntries(Object.keys(LABELS).map(key => [key, typeof stored[key] === "boolean" ? stored[key] : EXPERIENCED[key]])),
    };
  } catch (_) {
    return {...EXPERIENCED};
  }
}

let preferences = loadPreferences();

function savePreferences() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch (_) {}
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function categoryForText(text) {
  const value = normalize(text);
  if (!value || value === ".") return null;
  if (/ты погиб|возрожд|игрок повержен|ты снова у причала|погиб\./.test(value)) return "death";
  if (/угроза [1-5]|уровень угрозы|в бухту вош|снаружи бухты|подкреплен|ударная группа|преследовател|элитный стрелок.*высад/.test(value)) return "threat";
  if (/навод|прицел|готовит удар|занес нож|длинная очередь|захват подтвержден/.test(value)) return "aim";
  if (/здоровье \d|тебя сбили|тебя ранил|попала в тебя|ударил тебя/.test(value)) return "playerHit";
  if (/попал[аио]? в (твою |вашу )?лодк|протаранил лодк|лодк.*корпус \d|корпус лодки/.test(value)) return "boatHit";
  if (/ремонт тяжелого катера|ремонтных пластин|катер.*чин|аварийный ремонт|уходит на максимальной скорости|ремонт .* завершен/.test(value)) return "repair";
  if (/^попадание|прочность \d|осталось \d|корпус преследователя|цель .* осталось/.test(value)) return "combatStatus";
  return null;
}

function speechAllowed(text) {
  const category = categoryForText(text);
  return !category || preferences[category] !== false;
}

function applyPreset(preset) {
  preferences = {...preset};
  savePreferences();
  syncControls();
}

function setCustom(key, enabled) {
  preferences = {...preferences, profile: "custom", [key]: Boolean(enabled)};
  savePreferences();
  syncControls();
}

function setPressed(button, pressed, text) {
  if (!button) return;
  button.setAttribute("aria-pressed", String(Boolean(pressed)));
  button.textContent = text;
}

function ensureSettingsUi() {
  if (document.getElementById("combatGuidanceSettings")) return;
  const speechGroup = document.getElementById("speechSettingsTitle")?.closest?.(".settings-group");
  const parent = speechGroup?.parentElement;
  if (!speechGroup || !parent) return;

  const section = document.createElement("section");
  section.id = "combatGuidanceSettings";
  section.className = "settings-group";
  section.setAttribute("aria-labelledby", "combatGuidanceTitle");

  const title = document.createElement("h3");
  title.id = "combatGuidanceTitle";
  title.textContent = "Боевые подсказки и озвучка";

  const intro = document.createElement("p");
  intro.className = "settings-note";
  intro.textContent = "Опытный режим убирает очевидные фразы, но оставляет угрозы, наведение, повреждение лодки и ремонт противника. Ручные переключатели сохраняются только в этом браузере.";

  const presets = document.createElement("div");
  presets.className = "settings-grid";
  const beginner = document.createElement("button");
  beginner.id = "combatGuidanceBeginner";
  beginner.addEventListener("click", () => applyPreset(BEGINNER));
  const experienced = document.createElement("button");
  experienced.id = "combatGuidanceExperienced";
  experienced.addEventListener("click", () => applyPreset(EXPERIENCED));
  presets.append(beginner, experienced);

  const grid = document.createElement("div");
  grid.className = "settings-grid";
  for (const [key, label] of Object.entries(LABELS)) {
    void label;
    const button = document.createElement("button");
    button.id = `combatGuidance-${key}`;
    button.addEventListener("click", () => setCustom(key, !preferences[key]));
    grid.append(button);
  }

  section.append(title, intro, presets, grid);
  speechGroup.insertAdjacentElement("afterend", section);
  syncControls();
}

function syncControls() {
  setPressed(
    document.getElementById("combatGuidanceBeginner"),
    preferences.profile === "beginner",
    `Режим для новичка: ${preferences.profile === "beginner" ? "выбран" : "не выбран"}`,
  );
  setPressed(
    document.getElementById("combatGuidanceExperienced"),
    preferences.profile === "experienced",
    `Режим для опытного игрока: ${preferences.profile === "experienced" ? "выбран" : "не выбран"}`,
  );
  for (const [key, label] of Object.entries(LABELS)) {
    setPressed(
      document.getElementById(`combatGuidance-${key}`),
      preferences[key],
      `${label}: ${preferences[key] ? "озвучивать" : "не озвучивать"}`,
    );
  }
}

globalThis.__echoFreeRoamSpeechAllowed = speechAllowed;

function installSpeechFilter() {
  const synth = globalThis.speechSynthesis;
  if (!synth || synth.__echoCombatGuidanceInstalled) return;
  const previousSpeak = synth.speak?.bind?.(synth);
  if (!previousSpeak) return;
  const filteredSpeak = utterance => {
    if (speechAllowed(utterance?.text)) return previousSpeak(utterance);
    queueMicrotask(() => {
      try { utterance?.onend?.({type: "end", suppressed: true}); } catch (_) {}
    });
    return undefined;
  };
  try {
    Object.defineProperty(synth, "speak", {configurable: true, value: filteredSpeak});
    Object.defineProperty(synth, "__echoCombatGuidanceInstalled", {value: true});
  } catch (_) {}
}

function installAccessibleLiveFilter() {
  const prototype = globalThis.Node?.prototype;
  if (!prototype || prototype.__echoCombatGuidanceTextInstalled) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "textContent");
  if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) return;
  Object.defineProperty(prototype, "textContent", {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) {
      const text = String(value ?? "");
      if (this?.id === "live" && text && !speechAllowed(text)) {
        return descriptor.set.call(this, "");
      }
      if (this?.id === "message" && text && !speechAllowed(text)) {
        const previousRole = this.getAttribute?.("role");
        const previousLive = this.getAttribute?.("aria-live");
        this.setAttribute?.("role", "none");
        this.setAttribute?.("aria-live", "off");
        const result = descriptor.set.call(this, text);
        setTimeout(() => {
          if (previousRole == null) this.removeAttribute?.("role");
          else this.setAttribute?.("role", previousRole);
          if (previousLive == null) this.removeAttribute?.("aria-live");
          else this.setAttribute?.("aria-live", previousLive);
        }, 160);
        return result;
      }
      return descriptor.set.call(this, value);
    },
  });
  Object.defineProperty(prototype, "__echoCombatGuidanceTextInstalled", {value: true});
}

function spatial(audio, event, playerIndex, maximum) {
  if (Number(event?.sourcePlayer) === playerIndex) return {pan: 0, gain: 1};
  return audio.eventPanAndGain(event, maximum);
}

const originalHandle = FreeRoamAudio.prototype.handleFreeEvent;
FreeRoamAudio.prototype.handleFreeEvent = function handleCombatExperienceEvent(event, playerIndex) {
  if (!event?.targets?.includes(playerIndex)) return;

  if (event.type === "gun-shot" && ["pistol", "automatic"].includes(event.weapon || "automatic")) {
    const pistol = event.weapon === "pistol";
    const maximum = pistol ? COMBAT_TUNING.pistolAudibleRange : COMBAT_TUNING.automaticAudibleRange;
    const shot = spatial(this, event, playerIndex, maximum);
    if (shot.gain <= 0.002) return;
    const name = pistol && this.buffers.has("pistolShot") ? "pistolShot" : "automaticShot";
    this.play(name, {
      pan: shot.pan,
      gain: (pistol ? COMBAT_TUNING.pistolShotGain : COMBAT_TUNING.automaticShotGain) * shot.gain,
      rate: pistol ? 0.985 + Math.random() * 0.03 : 0.98 + Math.random() * 0.04,
      lowpass: 1600 + shot.gain * 11200,
    });
    return;
  }

  if (event.type === "enemy-gun-shot") {
    const pistol = event.weapon === "pistol";
    const maximum = event.gunnerId ? (pistol ? 190 : 230) : 285;
    const shot = this.eventPanAndGain(event, maximum);
    if (shot.gain <= 0.002) return;
    const name = pistol && this.buffers.has("pistolShot") ? "pistolShot" : "automaticShot";
    this.play(name, {
      pan: shot.pan,
      gain: (pistol ? 0.54 : 0.68) * shot.gain,
      rate: pistol ? 0.97 : 0.92 + Math.random() * 0.05,
      lowpass: 1300 + shot.gain * 10500,
    });
    return;
  }

  if (event.type === "heavy-gun-shot") {
    const shot = this.eventPanAndGain(event, 340);
    if (shot.gain <= 0.002) return;
    this.play("automaticShot", {
      pan: shot.pan,
      gain: 0.9 * shot.gain,
      rate: 0.72,
      lowpass: 1100 + shot.gain * 9400,
    });
    return;
  }

  if (event.type === "pursuer-aim") {
    if (!preferences.aim) return;
    const aim = this.eventPanAndGain(event, 260);
    if (aim.gain <= 0.002) return;
    const warningGain = 0.06 + aim.gain * 0.1;
    this.playSynthPip({pan: aim.pan, frequency: 260, gain: warningGain, duration: 0.08});
    this.playSynthPip({pan: aim.pan, frequency: 340, gain: warningGain * 1.08, duration: 0.1, delay: 0.14});
    return;
  }

  if (event.type === "heavy-gun-windup") {
    if (!preferences.aim) return;
    const aim = this.eventPanAndGain(event, 360);
    if (aim.gain <= 0.002) return;
    this.playSynthPip({pan: aim.pan, frequency: 125, gain: 0.19 * aim.gain, duration: 0.2});
    this.playSynthPip({pan: aim.pan, frequency: 170, gain: 0.17 * aim.gain, duration: 0.16, delay: 0.28});
    this.playSynthPip({pan: aim.pan, frequency: 220, gain: 0.16 * aim.gain, duration: 0.12, delay: 0.56});
    return;
  }

  if (["heavy-pursuer-approaching", "heavy-pursuer-arrived", "heavy-armour-breached", "heavy-repair-retreat", "heavy-repair-start", "heavy-repair-complete", "heavy-repair-returned"].includes(event.type)) {
    const sound = this.eventPanAndGain(event, 360);
    if (sound.gain > 0.002) {
      const frequencies = event.type === "heavy-armour-breached" ? [105, 155]
        : event.type.includes("repair") ? [290, 180]
          : [130, 205];
      this.playSynthPip({pan: sound.pan, frequency: frequencies[0], gain: 0.16 * sound.gain, duration: 0.18});
      this.playSynthPip({pan: sound.pan, frequency: frequencies[1], gain: 0.14 * sound.gain, duration: 0.2, delay: 0.2});
    }
    return;
  }

  return originalHandle.call(this, event, playerIndex);
};

function ensureHeavyLoop(audio) {
  if (audio.combatExperienceHeavyLoop || !audio.ctx || !audio.master || !audio.buffers.has("motorboatReal")) return;
  const source = audio.ctx.createBufferSource();
  const filter = audio.ctx.createBiquadFilter();
  const panner = audio.ctx.createStereoPanner();
  const gain = audio.ctx.createGain();
  source.buffer = audio.buffers.get("motorboatReal");
  source.loop = true;
  filter.type = "lowpass";
  filter.frequency.value = 500;
  gain.gain.value = 0;
  source.connect(filter).connect(panner).connect(gain).connect(audio.master);
  source.start();
  audio.combatExperienceHeavyLoop = {source, filter, panner, gain};
}

const originalUpdateWorld = FreeRoamAudio.prototype.updateWorld;
FreeRoamAudio.prototype.updateWorld = function updateCombatExperienceWorld(world, playerIndex) {
  originalUpdateWorld.call(this, world, playerIndex);
  const boat = world?.freeHeavyPursuer?.boat;
  const phase = world?.freeCombatAiV164?.heavy?.phase;
  const movingPhase = ["approach", "retreating", "returning"].includes(phase);
  if (!this.ctx || !this.listenerPoint || !boat?.active || boat.destroyed || !movingPhase) {
    if (this.ctx && this.combatExperienceHeavyLoop) {
      this.combatExperienceHeavyLoop.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.18);
    }
  } else {
    ensureHeavyLoop(this);
    const sound = this.eventPanAndGain(boat, 340);
    const speed = clamp(Math.abs(Number(boat.speed) || 0) / 13, 0, 1);
    const now = this.ctx.currentTime;
    if (this.combatExperienceHeavyLoop) {
      this.combatExperienceHeavyLoop.source.playbackRate.setTargetAtTime(0.54 + speed * 0.22, now, 0.12);
      this.combatExperienceHeavyLoop.filter.frequency.setTargetAtTime(420 + sound.gain * 2300, now, 0.16);
      this.combatExperienceHeavyLoop.panner.pan.setTargetAtTime(sound.pan, now, 0.1);
      this.combatExperienceHeavyLoop.gain.gain.setTargetAtTime((0.015 + speed * 0.18) * sound.gain, now, 0.16);
    }
  }

  if (phase === "repairing" && boat?.active && !boat.destroyed && this.ctx) {
    this.combatExperienceRepairAt ||= 0;
    if (this.ctx.currentTime >= this.combatExperienceRepairAt) {
      this.combatExperienceRepairAt = this.ctx.currentTime + 0.82;
      const sound = this.eventPanAndGain(boat, 260);
      if (sound.gain > 0.002) {
        if (this.buffers.has("repair")) {
          this.play("repair", {pan: sound.pan, gain: 0.38 * sound.gain, rate: 0.78, lowpass: 1200 + sound.gain * 4200});
        } else {
          this.playSynthPip({pan: sound.pan, frequency: 310, gain: 0.1 * sound.gain, duration: 0.09});
          this.playSynthPip({pan: sound.pan, frequency: 190, gain: 0.08 * sound.gain, duration: 0.13, delay: 0.13});
        }
      }
    }
  }
};

const originalStopAll = FreeRoamAudio.prototype.stopAll;
FreeRoamAudio.prototype.stopAll = function stopCombatExperienceAudio() {
  if (this.combatExperienceHeavyLoop) {
    try { this.combatExperienceHeavyLoop.source.stop(); } catch (_) {}
    this.combatExperienceHeavyLoop = null;
  }
  return originalStopAll.call(this);
};

installSpeechFilter();
installAccessibleLiveFilter();
ensureSettingsUi();

const settingsPanel = document.getElementById("settingsPanel");
settingsPanel?.addEventListener("click", () => {
  ensureSettingsUi();
  syncControls();
});

const settingsObserver = new MutationObserver(() => {
  ensureSettingsUi();
  syncControls();
});
if (settingsPanel) settingsObserver.observe(settingsPanel, {attributes: true, attributeFilter: ["hidden"]});

globalThis.__freeRoamCombatGuidance = {
  snapshot: () => ({...preferences}),
  setPreset(name) {
    applyPreset(name === "beginner" ? BEGINNER : EXPERIENCED);
    return {...preferences};
  },
  set(key, enabled) {
    if (!(key in LABELS)) return false;
    setCustom(key, enabled);
    return true;
  },
  categoryForText,
  speechAllowed,
};
