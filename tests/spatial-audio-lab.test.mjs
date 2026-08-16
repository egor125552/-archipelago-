import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/src/locations/spatial-lab/app.js", import.meta.url), "utf8");

test("lab audible check uses the production AudioEngine and common spatial adapter", () => {
  assert.match(app, /AudioEngine.*audio-engine-v13/);
  assert.match(app, /playSpatialTone/);
  assert.match(app, /await\s+audioEngine\.init\(\)/);
  assert.match(app, /playSpatialTone\(engine,\s*model/);
});

test("lab no longer creates a private AudioContext or bypasses the game master", () => {
  assert.doesNotMatch(app, /new\s+(?:AudioContext|webkitAudioContext)\s*\(/);
  assert.doesNotMatch(app, /\.destination\b/);
});
