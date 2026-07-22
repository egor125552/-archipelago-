import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  AUDIO_INTERVAL_MS,
  createChangeGate,
  isPredictionFrame,
} from "../public/src/free-roam-runtime-model.js";

test("change-only text gate commits only actual value changes", () => {
  const gate = createChangeGate("100%");
  assert.equal(gate.shouldCommit("100%"), false);
  assert.equal(gate.shouldCommit("99%"), true);
  assert.equal(gate.shouldCommit("99%"), false);
  assert.equal(gate.current(), "99%");
});

test("runtime separates the named prediction frame from ordinary animation callbacks", () => {
  function frame() {}
  function announceFrame() {}
  assert.equal(isPredictionFrame(frame), true);
  assert.equal(isPredictionFrame(announceFrame), false);
  assert.ok(AUDIO_INTERVAL_MS >= 30 && AUDIO_INTERVAL_MS <= 40);
});

test("dynamic free-roam prompts do not require desktop-only keys", async () => {
  const paths = [
    "../public/src/free-roam-cargo-guidance.js",
    "../public/src/free-roam-cargo-actions.js",
    "../public/src/free-roam-target-menu.js",
  ];
  const sources = await Promise.all(paths.map(path => readFile(new URL(path, import.meta.url), "utf8")));
  const combined = sources.join("\n");
  assert.doesNotMatch(combined, /нажми F|удержишь X|Enter подтверждает|Escape отменяет/i);
  assert.match(combined, /выполни действие/i);
  assert.match(combined, /отдельной команды атаки/i);
});

test("free-roam entry describes its actual scenario", async () => {
  const source = await readFile(new URL("../public/src/gameplay-v9.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /без заданий/i);
  assert.match(source, /доставка припасов/i);
  assert.match(source, /тремя катерами/i);
});

test("audio-only runtime disables map rendering and does not throttle network acknowledgements", async () => {
  const runtime = await readFile(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/free-roam.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/free-roam.css", import.meta.url), "utf8");

  assert.match(runtime, /FreeRoamAudio\.prototype\.updateWorld/);
  assert.match(runtime, /predictLocalWorld/);
  assert.match(runtime, /createChangeGate/);
  assert.match(runtime, /map\.getContext = \(\) => nullCanvasContext/);
  assert.doesNotMatch(runtime, /WebSocket\.prototype\.send|free-state-ack/);

  assert.doesNotMatch(html, /performanceButton|Облегчённый режим/);
  assert.match(html, /<canvas id="map" width="0" height="0" hidden aria-hidden="true">/);
  assert.match(html, /free-roam-quality-v1\.js\?v=2/);
  assert.match(html, /Один раз повернуть лодку/);
  assert.match(css, /#map \{ display: none !important; \}/);
});
