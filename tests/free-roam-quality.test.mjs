import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  LIGHTWEIGHT_ACK_DELAY_MS,
  LIGHTWEIGHT_FRAME_INTERVAL_MS,
  isFreeStateAckPayload,
  resolveLightweightPreference,
} from "../public/src/free-roam-quality-model.js";

test("lightweight mode defaults on for weak devices and respects a saved override", () => {
  assert.equal(resolveLightweightPreference({hardwareConcurrency: 4}), true);
  assert.equal(resolveLightweightPreference({deviceMemory: 4}), true);
  assert.equal(resolveLightweightPreference({hardwareConcurrency: 8, deviceMemory: 8}), false);
  assert.equal(resolveLightweightPreference({storedPreference: "off", hardwareConcurrency: 2}), false);
  assert.equal(resolveLightweightPreference({storedPreference: "on", hardwareConcurrency: 16}), true);
  assert.ok(LIGHTWEIGHT_FRAME_INTERVAL_MS >= 60);
  assert.ok(LIGHTWEIGHT_ACK_DELAY_MS >= 70);
});

test("only free-state acknowledgements are throttled", () => {
  assert.equal(isFreeStateAckPayload(JSON.stringify({type: "free-state-ack", sequence: 12})), true);
  assert.equal(isFreeStateAckPayload(JSON.stringify({type: "free-input", sequence: 12})), false);
  assert.equal(isFreeStateAckPayload("not json"), false);
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

test("free-roam page exposes lightweight mode and one-shot sonar wording", async () => {
  const html = await readFile(new URL("../public/free-roam.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/free-roam.css", import.meta.url), "utf8");
  assert.match(html, /id="performanceButton"/);
  assert.match(html, /free-roam-quality-v1\.js/);
  assert.match(html, /Один раз повернуть лодку/);
  assert.match(css, /body\.lightweight-mode #map/);
  assert.match(css, /#guideButton::before/);
});
