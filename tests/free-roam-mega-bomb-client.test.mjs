import assert from "node:assert/strict";
import test from "node:test";

import {outdoorReflectionPlan} from "../public/src/free-roam-mega-bomb-client.js";

test("outdoor explosion uses water and two image-source shore paths", () => {
  const event = {x: 205, y: 180, z: 0.35};
  const spatial = {
    pan: 0.72,
    gain: 0.8,
    distance: 90,
    listenerX: 150,
    listenerY: 250,
    listenerHeading: 15,
  };
  const plan = outdoorReflectionPlan(event, spatial);
  assert.equal(plan.dry.delay, 0);
  assert.ok(plan.water.delay > 0 && plan.water.delay < 0.02);
  assert.ok(plan.shoreNear.delay >= 0.012 && plan.shoreNear.delay <= 0.82);
  assert.ok(plan.shoreFar.delay >= plan.shoreNear.delay);
  assert.ok(plan.shoreFar.gain < plan.shoreNear.gain && plan.shoreNear.gain < plan.dry.gain);
  assert.ok(plan.shoreFar.lowpass < plan.shoreNear.lowpass);
  assert.notEqual(plan.shoreNear.pan, plan.dry.pan);
  assert.notEqual(plan.shoreNear.surface, plan.shoreFar.surface);
});

test("reflection planning clamps missing and extreme listener data safely", () => {
  const plan = outdoorReflectionPlan({x: 0, y: 0}, {pan: 12, gain: 9, distance: 9_000});
  for (const layer of Object.values(plan)) {
    assert.ok(layer.pan >= -1 && layer.pan <= 1);
    assert.ok(layer.gain >= 0 && layer.gain <= 1.4);
    assert.ok(layer.delay >= 0);
  }
  assert.ok(plan.shoreFar.delay <= 0.82);
});

test("client uses only supplied recordings and contains no synthesised audio", async () => {
  const {readFile} = await import("node:fs/promises");
  const source = await readFile(new URL("../public/src/free-roam-mega-bomb-client.js", import.meta.url), "utf8");
  assert.match(source, /mega-bomb-flight-real-v1\.mp3/);
  assert.match(source, /mega-bomb-explosion-real-v1\.mp3/);
  assert.match(source, /decodeAudioData/);
  assert.match(source, /createBufferSource/);
  assert.match(source, /createStereoPanner/);
  assert.match(source, /TEST_AMMO = 50/);
  assert.doesNotMatch(source, /createOscillator/);
  assert.doesNotMatch(source, /createBuffer\(/);
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /createConvolver/);
  assert.doesNotMatch(source, /createDelay/);
});
