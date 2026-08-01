import assert from "node:assert/strict";
import test from "node:test";

import {outdoorReflectionPlan} from "../public/src/free-roam-mega-bomb-client.js";

test("outdoor explosion uses short water and shore reflections, not room reverb", () => {
  const plan = outdoorReflectionPlan({pan: 0.72, gain: 0.8, distance: 90});
  assert.equal(plan.dry.delay, 0);
  assert.ok(plan.water.delay >= 0.07 && plan.water.delay < 0.15);
  assert.ok(plan.shore.delay >= 0.15 && plan.shore.delay < 0.32);
  assert.ok(plan.shore.gain < plan.water.gain && plan.water.gain < plan.dry.gain);
  assert.ok(plan.shore.lowpass < plan.water.lowpass);
  assert.notEqual(plan.water.pan, plan.dry.pan);
});

test("reflection planning clamps extreme spatial data safely", () => {
  const plan = outdoorReflectionPlan({pan: 12, gain: 9, distance: 9_000});
  for (const layer of Object.values(plan)) {
    assert.ok(layer.pan >= -1 && layer.pan <= 1);
    assert.ok(layer.gain >= 0 && layer.gain <= 1);
  }
  assert.ok(plan.water.delay <= 0.145);
  assert.ok(plan.shore.delay <= 0.31);
});

test("client reconstructs the analysed mono sound as spatial layers", async () => {
  const {readFile} = await import("node:fs/promises");
  const source = await readFile(new URL("../public/src/free-roam-mega-bomb-client.js", import.meta.url), "utf8");
  assert.match(source, /createStereoPanner/);
  assert.match(source, /createDynamicsCompressor/);
  assert.match(source, /bandpass/);
  assert.match(source, /frequency\.setValueAtTime\(62/);
  assert.match(source, /TEST_AMMO = 10/);
});
