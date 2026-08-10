import test from "node:test";
import assert from "node:assert/strict";

import {createSpeechController} from "../public/src/free-roam-speech.js?v=42";
import {
  COMBAT_GUIDANCE_STORAGE_KEY,
  combatGuidanceCategory,
  speechPolicyAllows,
} from "../public/src/free-roam-speech-policy.js?v=1";

function storageWithGuidance(overrides = {}) {
  const values = new Map();
  values.set(COMBAT_GUIDANCE_STORAGE_KEY, JSON.stringify({
    profile: "custom",
    death: true,
    threat: true,
    aim: true,
    playerHit: false,
    boatHit: true,
    repair: true,
    combatStatus: false,
    ...overrides,
  }));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function fakeSpeech() {
  const state = {cancelCount: 0, speakCount: 0, utterances: []};
  class Utterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.voice = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  const synth = {
    cancel() { state.cancelCount += 1; },
    speak(utterance) {
      state.speakCount += 1;
      state.utterances.push(utterance);
    },
    resume() {},
    getVoices() { return []; },
    addEventListener() {},
  };
  return {state, synth, Utterance};
}

test("muted combat speech never cancels the phrase already being spoken", () => {
  const storage = storageWithGuidance({playerHit: false});
  const {state, synth, Utterance} = fakeSpeech();
  const speech = createSpeechController({synth, Utterance, storage});

  assert.equal(speech.speak("Рядом: герметичная дверь в кормовой отсек."), true);
  assert.equal(state.cancelCount, 1);
  assert.equal(state.speakCount, 1);
  assert.equal(speech.activeText, "Рядом: герметичная дверь в кормовой отсек.");

  assert.equal(speech.speak("Здоровье 99."), false, "disabled player-health speech must be rejected before replacement starts");
  assert.equal(state.cancelCount, 1, "muted speech must not call speechSynthesis.cancel");
  assert.equal(state.speakCount, 1, "muted speech must not reach speechSynthesis.speak");
  assert.equal(speech.activeText, "Рядом: герметичная дверь в кормовой отсек.", "the currently speaking phrase must stay active");

  storage.setItem(COMBAT_GUIDANCE_STORAGE_KEY, JSON.stringify({
    profile: "custom",
    death: true,
    threat: true,
    aim: true,
    playerHit: true,
    boatHit: true,
    repair: true,
    combatStatus: false,
  }));

  assert.equal(speech.speak("Здоровье 99."), true, "the same category may interrupt once the player explicitly enables it");
  assert.equal(state.cancelCount, 2);
  assert.equal(state.speakCount, 2);
  assert.equal(speech.activeText, "Здоровье 99.");
  state.utterances.at(-1)?.onend?.({type: "end"});
});

test("all combat guidance switches are policy gates, while ordinary deck speech remains allowed", () => {
  const storage = storageWithGuidance({
    death: false,
    threat: false,
    aim: false,
    playerHit: false,
    boatHit: false,
    repair: false,
    combatStatus: false,
  });
  const samples = [
    ["Ты погиб.", "death"],
    ["Уровень угрозы 4.", "threat"],
    ["Противник готовит удар.", "aim"],
    ["Здоровье 76.", "playerHit"],
    ["Попали в твою лодку. Корпус 80.", "boatHit"],
    ["Аварийный ремонт тяжёлого катера начат.", "repair"],
    ["Попадание по вражескому бойцу. Осталось 16.", "combatStatus"],
  ];

  for (const [phrase, category] of samples) {
    assert.equal(combatGuidanceCategory(phrase), category);
    assert.equal(speechPolicyAllows(phrase, {storage}), false, `${category} must be completely silent when disabled`);
  }
  assert.equal(speechPolicyAllows("Рядом: герметичная дверь в кормовой отсек.", {storage}), true);
});

test("target menu remains speech-authoritative even when its text contains enemy health", () => {
  const storage = storageWithGuidance({playerHit: false, combatStatus: false});
  const phrase = "Цель 1 из 1: вражеский автоматчик, 22 метров, здоровье 52. Захват подтверждён.";
  assert.equal(combatGuidanceCategory(phrase), null, "target-menu phrases must bypass combat detail classification");
  assert.equal(speechPolicyAllows(phrase, {storage}), true);
});
