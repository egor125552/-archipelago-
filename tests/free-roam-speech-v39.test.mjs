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

test("ordinary announcements keep only the latest pending phrase", () => {
  const fake = fakeSpeech();
  const speech = createSpeechController(fake);
  speech.speak("Первая фраза");
  speech.speak("Устаревшая позиция");
  speech.speak("Новая позиция");

  assert.equal(fake.utterances.length, 1);
  assert.equal(speech.pendingText, "Новая позиция");
  fake.utterances[0].onend();
  assert.equal(fake.utterances.length, 2);
  assert.equal(fake.utterances[1].text, "Новая позиция");
  assert.equal(fake.utterances[1].voice.name, "Milena Enhanced");
  speech.cancel();
});

test("critical speech interrupts without permanently disabling later speech", async () => {
  const fake = fakeSpeech();
  const speech = createSpeechController(fake);
  speech.speak("Обычная подсказка");
  speech.speak("Критическая пробоина", {interrupt: true});
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.equal(fake.cancelCount(), 1);
  assert.equal(fake.utterances.at(-1).text, "Критическая пробоина");
  fake.utterances.at(-1).onend();
  speech.speak("Озвучка продолжает работать");
  assert.equal(fake.utterances.at(-1).text, "Озвучка продолжает работать");
  speech.cancel();
});

test("Russian enhanced voices outrank compact and non-Russian voices", () => {
  assert.ok(
    russianVoiceScore({lang: "ru-RU", name: "Milena Enhanced"})
      > russianVoiceScore({lang: "ru-RU", name: "Russian Compact"}),
  );
  assert.ok(russianVoiceScore({lang: "ru-RU", name: "Russian"}) > russianVoiceScore({lang: "en-US", name: "English"}));
});
