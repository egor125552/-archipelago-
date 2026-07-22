import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  AUDIO_INTERVAL_MS,
  createChangeGate,
  isPredictionFrame,
} from "../public/src/free-roam-runtime-model.js";

test("audio updates use a separate bounded interval", () => {
  assert.ok(AUDIO_INTERVAL_MS >= 25);
  assert.ok(AUDIO_INTERVAL_MS <= 60);
});

test("change gates commit only real text changes", () => {
  const gate = createChangeGate("готово");
  assert.equal(gate.shouldCommit("готово"), false);
  assert.equal(gate.shouldCommit("в пути"), true);
  assert.equal(gate.shouldCommit("в пути"), false);
  assert.equal(gate.current(), "в пути");
});

test("only the main prediction frame is separated from ordinary animation callbacks", () => {
  function frame() {}
  function announceFrame() {}
  assert.equal(isPredictionFrame(frame), true);
  assert.equal(isPredictionFrame(announceFrame), false);
  assert.equal(isPredictionFrame(null), false);
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

test("free-roam page exposes the audio-only runtime and one-shot sonar wording", async () => {
  const html = await readFile(new URL("../public/free-roam.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/free-roam.css", import.meta.url), "utf8");
  const quality = await readFile(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8");
  assert.match(html, /id="performanceButton"/);
  assert.match(html, /free-roam-quality-v1\.js/);
  assert.match(html, /Один раз повернуть лодку/);
  assert.match(css, /body\.lightweight-mode #map/);
  assert.match(css, /#guideButton::before/);
  assert.match(quality, /audio-only-map/);
  assert.match(quality, /free-roam-runtime-model\.js/);
});
