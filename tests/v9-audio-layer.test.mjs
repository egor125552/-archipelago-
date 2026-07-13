import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {floodMuffleCutoff} from "../public/src/audio-engine-v9.js";

const source = await readFile(new URL("../public/src/audio-engine-v9.js", import.meta.url), "utf8");

test("v9 uses separate recorded river, wake and bilge sources", () => {
  assert.match(source, /river-ambience\.ogg/);
  assert.match(source, /boat-wake\.ogg/);
  assert.match(source, /bilge-water\.ogg/);
  assert.doesNotMatch(source, /raw\.githubusercontent\.com/);
  assert.match(source, /riverIdle/);
  assert.match(source, /riverWake/);
  assert.match(source, /bilgeWater/);
});

test("wake is enabled only while the boat is actually moving", () => {
  assert.match(source, /const moving = speed >= 0\.35/);
  assert.match(source, /if \(moving\)[\s\S]*ensureLoop\(wakeName/);
  assert.match(source, /else \{\s*this\.stopLoop\("riverWake"\)/);
});

test("flooding closes the global mix filter instead of merely lowering volume", () => {
  assert.match(source, /createBiquadFilter/);
  assert.match(source, /this\.compressor\.connect\(this\.floodFilter\)/);
  assert.match(source, /setTargetAtTime\(cutoff/);
  assert.ok(floodMuffleCutoff(0) > floodMuffleCutoff(50));
  assert.ok(floodMuffleCutoff(50) > floodMuffleCutoff(100));
  assert.ok(floodMuffleCutoff(100) <= 650);
});

test("legacy sea fallback is removed after river buffers load", () => {
  assert.match(source, /const riverReady =/);
  assert.match(source, /if \(riverReady\) this\.stopLoop\("seaReal"\)/);
  assert.match(source, /legacyLoopsCleared/);
});
