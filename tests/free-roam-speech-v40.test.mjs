import test from "node:test";
import assert from "node:assert/strict";

import {createSpeechController, russianVoiceScore} from "../public/src/free-roam-speech.js";

function fakeSpeech() {
  const utterances = [];
  let cancelCount = 0;
  class Utterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.voice = null;
    }
  }
  const synth = {
    getVoices: () => [
      {name: "English", lang: "en-US", voiceURI: "english"},
      {name: "Milena Enhanced", lang: "ru-RU", voiceURI: "milena"},
    ],
    speak: utterance => utterances.push(utterance),
    cancel: () => { cancelCount += 1; },
    resume() {},
    addEventListener() {},
  };
  return {synth, Utterance, utterances, cancelCount: () => cancelCount};
}

test("ordinary announcements immediately replace speech without a delayed queue", () => {
  const fake = fakeSpeech();
  const speech = createSpeechController(fake);
  speech.speak("Первая фраза");
  speech.speak("Устаревшая позиция");
  speech.speak("Новая позиция");

  assert.equal(fake.cancelCount(), 3);
  assert.equal(fake.utterances.length, 3);
  assert.equal(fake.utterances.at(-1).text, "Новая позиция");
  assert.equal(fake.utterances.at(-1).voice.name, "Milena Enhanced");
  assert.equal(speech.activeText, "Новая позиция");
  assert.equal(speech.pendingText, "");
  speech.cancel();
});

test("critical speech replaces immediately without disabling later speech", () => {
  const fake = fakeSpeech();
  const speech = createSpeechController(fake);
  speech.speak("Обычная подсказка");
  speech.speak("Критическая пробоина", {interrupt: true});

  assert.equal(fake.cancelCount(), 2);
  assert.equal(fake.utterances.at(-1).text, "Критическая пробоина");
  fake.utterances.at(-1).onend();
  speech.speak("Озвучка продолжает работать");
  assert.equal(fake.utterances.at(-1).text, "Озвучка продолжает работать");
  speech.cancel();
});

test("keyboard activation cannot silently disable game speech again", async () => {
  const source = await import("node:fs/promises")
    .then(fs => fs.readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /readerInputDetected/);
  assert.doesNotMatch(source, /event\.detail\s*===\s*0[\s\S]{0,160}setEnabled\s*\(\s*false/);
});

test("enhanced Russian voices outrank compact and non-Russian voices", () => {
  assert.ok(
    russianVoiceScore({lang: "ru-RU", name: "Milena Enhanced"})
      > russianVoiceScore({lang: "ru-RU", name: "Russian Compact"}),
  );
  assert.ok(russianVoiceScore({lang: "ru-RU", name: "Russian"}) > russianVoiceScore({lang: "en-US", name: "English"}));
});
