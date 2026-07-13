import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const source = await readFile(new URL("../public/src/audio-engine-v9.js", import.meta.url), "utf8");

test("v9 uses separate recorded river, wake and bilge sources", () => {
  assert.match(source, /running_water-004\.ogg/);
  assert.match(source, /running_water-019\.ogg/);
  assert.match(source, /running_water-026\.ogg/);
  assert.match(source, /riverIdle/);
  assert.match(source, /riverWake/);
  assert.match(source, /bilgeWater/);
});

test("wake is enabled only while the boat is actually moving", () => {
  assert.match(source, /const moving = speed >= 0\.35/);
  assert.match(source, /if \(moving\)[\s\S]*ensureLoop\(wakeName/);
  assert.match(source, /else \{\s*this\.stopLoop\("riverWake"\)/);
});

test("internal water opens its filter as flooding rises", () => {
  assert.match(source, /const openness = clamp\(water \/ 72, 0, 1\)/);
  assert.match(source, /lowpass: 420 \+ openness \* 7900/);
  assert.match(source, /gain: 0\.012 \+ openness \* 0\.245/);
});

test("legacy sea fallback is removed after river buffers load", () => {
  assert.match(source, /const riverReady =/);
  assert.match(source, /if \(riverReady\) this\.stopLoop\("seaReal"\)/);
  assert.match(source, /legacyLoopsCleared/);
});
