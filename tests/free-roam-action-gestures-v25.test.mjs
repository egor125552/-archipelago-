import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {classifyActionGesture} from "../public/src/free-roam-action-gestures.js";

test("one-finger taps act, double taps jump and a stationary hold makes a strong attack", () => {
  assert.equal(classifyActionGesture({pointers: 1, duration: 120, dx: 2, dy: 3, movement: 4, taps: 1}), "action");
  assert.equal(classifyActionGesture({pointers: 1, duration: 160, dx: 1, dy: 2, movement: 3, taps: 2}), "jump");
  assert.equal(classifyActionGesture({pointers: 1, duration: 720, dx: 3, dy: 1, movement: 4, taps: 1}), "attack-heavy");
  assert.equal(classifyActionGesture({pointers: 1, duration: 350, dx: 80, dy: 5, movement: 82, taps: 1}), null);
});

test("two-finger gestures control sonar, pump, repair, weapon and the button panel", () => {
  assert.equal(classifyActionGesture({pointers: 2, duration: 180, dx: 2, dy: 2, movement: 5}), "sonar");
  assert.equal(classifyActionGesture({pointers: 2, duration: 180, dx: 2, dy: 2, movement: 5, taps: 2}), "status");
  assert.equal(classifyActionGesture({pointers: 2, duration: 700, dx: 2, dy: 3, movement: 5}), "repair");
  assert.equal(classifyActionGesture({pointers: 2, duration: 340, dx: 90, dy: 8, movement: 94}), "weapon");
  assert.equal(classifyActionGesture({pointers: 2, duration: 340, dx: 5, dy: -90, movement: 92}), "pump");
  assert.equal(classifyActionGesture({pointers: 2, duration: 340, dx: 5, dy: 90, movement: 92}), "buttons");
});

test("three-finger taps provide quick and strong attacks", () => {
  assert.equal(classifyActionGesture({pointers: 3, duration: 180, dx: 2, dy: 2, movement: 5}), "attack-light");
  assert.equal(classifyActionGesture({pointers: 3, duration: 680, dx: 3, dy: 2, movement: 5}), "attack-heavy");
});

test("the iPhone gesture area covers the game section and documents every action", async () => {
  const [html, client, css] = await Promise.all([
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8"),
    readFile(new URL("../public/free-roam.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="gestureGuide"/);
  assert.match(client, /const surface = \$\("game"\)/);
  assert.match(client, /runGestureCommand/);
  assert.match(client, /attack-heavy/);
  assert.match(client, /actionPulse\("weapon"\)/);
  assert.match(client, /function releaseAllMovement\(\)\s*\{[^}]*activeTouches\.clear\(\)/);
  assert.match(css, /body\.gesture-mode #game\s*\{[^}]*touch-action:\s*none/);
});
