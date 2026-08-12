import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const audioV2 = readFileSync(new URL("../public/src/free-roam-audio-v2.js", import.meta.url), "utf8");
const audioV3 = readFileSync(new URL("../public/src/free-roam-audio-v3.js", import.meta.url), "utf8");
const vesselLoader = readFileSync(new URL("../public/src/free-roam-dual-turret-client.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/worker-resilient.js", import.meta.url), "utf8");

test("medium crew ship cannot fall through to the ordinary light-boat engine", () => {
  assert.match(audioV2, /profile\.startsWith\("medium-crew"\)/);
  assert.match(audioV2, /!hasDedicatedVesselEngine\(localBoat\)/);
});

test("release 1.7.3 forces fresh vessel modules after the stale-cache regressions", () => {
  assert.match(audioV3, /free-roam-audio-v2\.js\?v=41/);
  assert.match(vesselLoader, /medium-crew-vessel-client\.js\?v=4/);
  assert.match(worker, /free-roam-dual-turret-client\.js\?v=7[\s\S]*?free-roam-dual-turret-client\.js\?v=11/);
  assert.match(worker, /free-roam-audio-v3\.js\?v=39[\s\S]*?free-roam-audio-v3\.js\?v=40/);
  assert.match(worker, /free-roam-audio-v2\.js\?v=40[\s\S]*?free-roam-audio-v2\.js\?v=41/);
  assert.match(worker, /vessel-plugin-manifest\.js\?v=8[\s\S]*?vessel-plugin-manifest\.js\?v=9/);
  assert.match(worker, /free-roam-shop\.js\?v=5[\s\S]*?free-roam-shop\.js\?v=6/);
  assert.match(worker, /vessel-deck-input-bridge-system\.js\?v=3[\s\S]*?vessel-deck-input-bridge-system\.js\?v=4/);
});
