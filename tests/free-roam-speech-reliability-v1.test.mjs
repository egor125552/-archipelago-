import test from "node:test";
import assert from "node:assert/strict";
import {installSpeechReliability} from "../public/src/free-roam-speech-reliability-v1.js";

function harness() {
  let clock = 100;
  let nextId = 1;
  const timers = new Map();
  const spoken = [];
  let cancels = 0;
  const synth = {
    speak(utterance) { spoken.push(utterance.text); },
    cancel() { cancels += 1; },
  };
  installSpeechReliability(synth, {
    delayMs: 48,
    now: () => clock,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, {callback, at: clock + delay});
      return id;
    },
    clearTimer(id) { timers.delete(id); },
  });
  function advance(ms) {
    clock += ms;
    const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock);
    for (const [id, timer] of due) {
      timers.delete(id);
      timer.callback();
    }
  }
  return {synth, spoken, get cancels() { return cancels; }, advance};
}

test("speak is delayed after cancel instead of being dropped in the same task", () => {
  const h = harness();
  h.synth.cancel();
  h.synth.speak({text: "Цель один"});
  assert.deepEqual(h.spoken, []);
  h.advance(48);
  assert.deepEqual(h.spoken, ["Цель один"]);
  assert.equal(h.cancels, 1);
});

test("rapid target changes keep only the newest announcement", () => {
  const h = harness();
  h.synth.cancel();
  h.synth.speak({text: "Цель один"});
  h.advance(10);
  h.synth.cancel();
  h.synth.speak({text: "Цель два"});
  h.advance(48);
  assert.deepEqual(h.spoken, ["Цель два"]);
});

test("cancel without replacement removes a pending phrase", () => {
  const h = harness();
  h.synth.cancel();
  h.synth.speak({text: "Старая цель"});
  h.synth.cancel();
  h.advance(100);
  assert.deepEqual(h.spoken, []);
});
