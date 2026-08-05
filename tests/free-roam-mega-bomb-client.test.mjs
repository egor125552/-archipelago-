import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {spatialState} from "../public/src/free-roam-mega-bomb-client.js";

test("flight pan follows the authoritative server pan", () => {
  const state = spatialState({speed: 48, spatial: [{pan: 0.73, distance: 35, radialSpeed: 0, speed: 48}]}, 0, "flight");
  assert.equal(state.pan, 0.73);
});

test("the real flight recording follows physical velocity", () => {
  const slow = spatialState({speed: 18, spatial: [{pan: 0, distance: 10, speed: 18}]}, 0, "flight");
  const fast = spatialState({speed: 72, spatial: [{pan: 0, distance: 10, speed: 72}]}, 0, "flight");
  assert.ok(slow.rate < fast.rate);
  assert.ok(slow.gain < fast.gain);
});

test("approaching and receding radial speed change the same recording", () => {
  const approaching = spatialState({speed: 48, spatial: [{pan: 0, distance: 20, speed: 48, radialSpeed: -50}]}, 0, "flight");
  const receding = spatialState({speed: 48, spatial: [{pan: 0, distance: 20, speed: 48, radialSpeed: 50}]}, 0, "flight");
  assert.ok(approaching.rate > receding.rate);
});

test("server occlusion makes the physical flight quieter and more muffled", () => {
  const clear = spatialState({speed: 48, spatial: [{pan: 0.2, distance: 50, speed: 48, occluded: false}]}, 0, "flight");
  const blocked = spatialState({speed: 48, spatial: [{pan: 0.2, distance: 50, speed: 48, occluded: true}]}, 0, "flight");
  assert.ok(blocked.gain < clear.gain);
  assert.ok(blocked.lowpass < clear.lowpass);
});

test("the release client loads complete binary recordings through the shared audio graph", async () => {
  const source = await readFile(new URL("../public/src/free-roam-mega-bomb-client-v25.js", import.meta.url), "utf8");
  assert.match(source, /mega-bomb-flight-real-v1\.mp3\?v=6/);
  assert.match(source, /mega-bomb-explosion-v12\.mp3\?v=14/);
  assert.match(source, /free-roam-audio-v5\.js\?v=45/);
  assert.match(source, /source\.loop = Boolean/);
  assert.match(source, /response\.arrayBuffer/);
  assert.doesNotMatch(source, /EXPLOSION_PARTS|KILL_AUDIO_PARTS|\.part-|\.b64|atob|Uint8Array/);
  assert.doesNotMatch(source, /createOscillator|createConvolver/);
});
