import test from "node:test";
import assert from "node:assert/strict";

import {
  SPEECH_OUTPUT_MODE_KEY,
  SPEECH_OUTPUT_GAME,
  SPEECH_OUTPUT_SCREENREADER,
  installSpeechOutputMode,
  storedSpeechOutputMode,
} from "../public/src/free-roam-speech-output-mode.js?v=1";

function fixture(initialMode = SPEECH_OUTPUT_GAME) {
  const values = new Map([[SPEECH_OUTPUT_MODE_KEY, initialMode]]);
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  const state = {nativeSpeaks: 0, cancels: 0};
  const speechSynthesis = {
    speak() { state.nativeSpeaks += 1; },
    cancel() { state.cancels += 1; },
  };
  const global = {
    localStorage: storage,
    speechSynthesis,
    document: null,
    dispatchEvent() {},
  };
  return {global, storage, state, speechSynthesis};
}

test("screen reader output mode suppresses Web Speech while completing its lifecycle", async () => {
  const {global, storage, state, speechSynthesis} = fixture();
  const api = installSpeechOutputMode(global);

  assert.equal(api.mode(), SPEECH_OUTPUT_GAME);
  speechSynthesis.speak({text: "Обычный голос"});
  assert.equal(state.nativeSpeaks, 1, "game voice mode must keep the browser speech engine");

  api.setMode(SPEECH_OUTPUT_SCREENREADER);
  assert.equal(storedSpeechOutputMode(storage), SPEECH_OUTPUT_SCREENREADER);
  assert.equal(state.cancels, 1, "switching authority to the screen reader must stop any old browser utterance");

  let ended = false;
  speechSynthesis.speak({text: "Сообщение для NVDA", onend: () => { ended = true; }});
  assert.equal(state.nativeSpeaks, 1, "screen reader mode must not produce a duplicate browser voice");
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(ended, true, "suppressed Web Speech must finish immediately so the speech controller cannot stall");

  api.setMode(SPEECH_OUTPUT_GAME);
  speechSynthesis.speak({text: "Голос игры снова включён"});
  assert.equal(state.nativeSpeaks, 2);
});

test("unknown persisted output modes safely fall back to the game voice", () => {
  const {storage} = fixture("not-a-mode");
  assert.equal(storedSpeechOutputMode(storage), SPEECH_OUTPUT_GAME);
});
