import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const audioSource = fs.readFileSync(
  new URL("../public/src/free-roam-elite-boat-audio-v11.js", import.meta.url),
  "utf8",
);
const qualitySource = fs.readFileSync(
  new URL("../public/src/free-roam-quality-v1.js", import.meta.url),
  "utf8",
);

test("elite boss bullet audio accepts array and keyed-object projectile collections", () => {
  assert.match(audioSource, /const values = value => Array\.isArray\(value\)/);
  assert.match(audioSource, /Object\.values\(value\)/);
  assert.match(audioSource, /values\(boss\.projectiles\)\s*\n\s*\.filter/);
  assert.doesNotMatch(audioSource, /\(boss\.projectiles \|\| \[\]\)\s*\n?\s*\.filter/);
});

test("quality loader cache-busts the fixed elite boss audio module", () => {
  assert.match(qualitySource, /free-roam-elite-boat-audio-v11\.js\?v=4/);
  assert.doesNotMatch(qualitySource, /free-roam-elite-boat-audio-v11\.js\?v=3/);
});
