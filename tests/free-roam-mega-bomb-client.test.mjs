import assert from "node:assert/strict";
import test from "node:test";

import {
  KILL_EVENT_TYPES,
  outdoorReflectionPlan,
  pathOccludedByLand,
} from "../public/src/free-roam-mega-bomb-client.js";

test("outdoor explosion uses travel time and reflections from the real shore rectangle", () => {
  const event = {x: 205, y: 180, z: 0.35, surface: "water"};
  const spatial = {
    pan: 0.72,
    gain: 0.8,
    distance: 90,
    listenerX: 150,
    listenerY: 250,
    listenerHeading: 15,
  };
  const plan = outdoorReflectionPlan(event, spatial);
  assert.ok(plan.dry.delay > 0.25 && plan.dry.delay < 0.28);
  assert.ok(plan.water.delay > plan.dry.delay);
  assert.ok(plan.shoreNear.delay > plan.dry.delay);
  assert.ok(plan.shoreFar.delay > plan.shoreNear.delay);
  assert.ok(plan.shoreFar.gain < plan.shoreNear.gain && plan.shoreNear.gain < plan.dry.gain);
  assert.ok(plan.shoreFar.lowpass < plan.shoreNear.lowpass);
  assert.notEqual(plan.shoreNear.pan, plan.dry.pan);
  assert.notEqual(plan.shoreNear.surface, plan.shoreFar.surface);
  assert.equal(plan.diffraction.gain, 0);
});

test("land mass blocks the direct path and creates one muffled diffraction path", () => {
  const source = {x: 90, y: 40};
  const listener = {x: 330, y: 40, heading: 0};
  assert.equal(pathOccludedByLand(source, listener), true);
  const plan = outdoorReflectionPlan(
    {...source, z: 0.35, surface: "ground"},
    {pan: 0.2, gain: 0.9, distance: 240, listenerX: listener.x, listenerY: listener.y, listenerHeading: listener.heading},
  );
  assert.equal(plan.dry.occluded, true);
  assert.ok(plan.dry.gain < 0.1);
  assert.ok(plan.dry.lowpass <= 700);
  assert.ok(plan.diffraction.gain > plan.dry.gain);
  assert.ok(plan.diffraction.delay > plan.dry.delay);
});

test("reflection planning clamps missing and extreme listener data safely", () => {
  const plan = outdoorReflectionPlan({x: 0, y: 0}, {pan: 12, gain: 9, distance: 9_000});
  for (const layer of Object.values(plan)) {
    assert.ok(layer.pan >= -1 && layer.pan <= 1);
    assert.ok(layer.gain >= 0 && layer.gain <= 1.4);
    assert.ok(layer.delay >= 0);
  }
  assert.ok(plan.shoreFar.delay <= 1.8);
});

test("client uses only supplied recordings and confirms every player-caused enemy kill", async () => {
  const {readFile} = await import("node:fs/promises");
  const source = await readFile(new URL("../public/src/free-roam-mega-bomb-client.js", import.meta.url), "utf8");
  assert.match(source, /mega-bomb-flight-real-v1\.mp3/);
  assert.match(source, /mega-bomb-explosion-real-v1\.mp3/);
  assert.match(source, /enemy-killed-v1\.part-00\.b64/);
  assert.match(source, /decodeAudioData/);
  assert.match(source, /createBufferSource/);
  assert.match(source, /createStereoPanner/);
  assert.match(source, /TEST_AMMO = 100/);
  assert.ok(KILL_EVENT_TYPES.has("enemy-boat-destroyed"));
  assert.ok(KILL_EVENT_TYPES.has("hostile-actor-destroyed"));
  assert.ok(KILL_EVENT_TYPES.has("heavy-turret-destroyed"));
  assert.ok(KILL_EVENT_TYPES.has("heavy-pursuer-destroyed"));
  assert.doesNotMatch(source, /createOscillator/);
  assert.doesNotMatch(source, /createBuffer\(/);
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /createConvolver/);
  assert.doesNotMatch(source, /createDelay/);
});
