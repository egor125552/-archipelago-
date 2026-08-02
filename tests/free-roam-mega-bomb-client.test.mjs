import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  KILL_EVENT_TYPES,
  flightAudioState,
  outdoorReflectionPlan,
  pathOccludedByLand,
} from "../public/src/free-roam-mega-bomb-client.js";

test("flight pan follows the authoritative server pan without a decorative arc", () => {
  const state = flightAudioState(
    {speed: 48, vx: 48, vy: 0, vz: 0},
    {pan: 0.73, gain: 0.8, distance: 35, radialSpeed: 0, speed: 48},
  );
  assert.equal(state.pan, 0.73);
});

test("the recorded flight slows down and speeds up with physical velocity", () => {
  const slow = flightAudioState({speed: 18}, {pan: 0, gain: 1, distance: 10, speed: 18});
  const fast = flightAudioState({speed: 72}, {pan: 0, gain: 1, distance: 10, speed: 72});
  assert.ok(slow.playbackRate < 0.7);
  assert.ok(fast.playbackRate > 1.4);
});

test("approaching and receding radial speed affect the same real recording", () => {
  const approaching = flightAudioState(
    {speed: 48},
    {pan: 0, gain: 1, distance: 20, speed: 48, radialSpeed: -50},
  );
  const receding = flightAudioState(
    {speed: 48},
    {pan: 0, gain: 1, distance: 20, speed: 48, radialSpeed: 50},
  );
  assert.ok(approaching.playbackRate > receding.playbackRate);
});

test("land occlusion leaves a quiet muffled direct impact and diffraction tail", () => {
  const source = {x: 90, y: 40, surface: "water", reason: "water-impact"};
  const listener = {x: 330, y: 40};
  assert.equal(pathOccludedByLand(source, listener), true);
  const plan = outdoorReflectionPlan(source, {
    pan: 0.3,
    gain: 0.9,
    distance: 240,
    listenerX: listener.x,
    listenerY: listener.y,
    occluded: true,
  });
  assert.equal(plan.dry.occluded, true);
  assert.ok(plan.dry.gain < plan.diffraction.gain);
  assert.ok(plan.dry.lowpass < 1000);
  assert.ok(plan.diffraction.gain > 0);
});

test("water and ground impacts have different acoustic plans", () => {
  const spatial = {pan: -0.6, gain: 0.8, distance: 45, listenerX: 80, listenerY: 200};
  const water = outdoorReflectionPlan(
    {x: 60, y: 180, surface: "water", reason: "water-impact"},
    spatial,
  );
  const ground = outdoorReflectionPlan(
    {x: 160, y: 40, surface: "ground", reason: "ground-impact"},
    spatial,
  );
  assert.ok(water.dry.lowpass < ground.dry.lowpass);
  assert.ok(water.water.gain > ground.water.gain);
  assert.ok(ground.shoreNear.gain > water.shoreNear.gain);
});

test("the client uses direct binary recordings and reacts to server ricochets", async () => {
  const source = await readFile(
    new URL("../public/src/free-roam-mega-bomb-client-v15.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /mega-bomb-flight-real-v1\.mp3\?v=5/);
  assert.match(source, /mega-bomb-explosion-v10\.mp3\?v=1/);
  assert.match(source, /enemy-killed-v5\.mp3\?v=1/);
  assert.match(source, /mega-bomb-ricochet/);
  assert.match(source, /source\.loop = true/);
  assert.doesNotMatch(source, /audioArcSide|flightPan|EXPLOSION_PARTS|KILL_AUDIO_PARTS/);
  assert.doesNotMatch(source, /atob|Uint8Array|createOscillator|Math\.random|createConvolver|createDelay/);
  assert.ok(KILL_EVENT_TYPES.has("enemy-boat-destroyed"));
  assert.ok(KILL_EVENT_TYPES.has("heavy-pursuer-destroyed"));
});
