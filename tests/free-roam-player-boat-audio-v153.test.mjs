import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {
  PLAYER_BOAT_AUDIO_RANGES,
  playerBoatAudioSources,
} from "../public/src/free-roam-player-boat-audio-v1.js";

test("leaving a boat exposes both player-owned boats as stereo sources", () => {
  const world = createFreeWorld();
  Object.assign(world.players[0], {mode: "swim", activeBoat: null, x: 210, y: 170});
  Object.assign(world.boats[0], {x: 190, y: 170, engineStalled: false, throttle: 0});
  Object.assign(world.boats[1], {x: 250, y: 170, engineStalled: false, throttle: 0});
  Object.assign(world.players[1], {mode: "foot", activeBoat: null});

  const sources = playerBoatAudioSources(world, 0);
  assert.equal(sources.length, 2);
  const own = sources.find(source => source.isOwn);
  const other = sources.find(source => !source.isOwn);
  assert.ok(own.pan < 0);
  assert.ok(other.pan > 0);
  assert.ok(own.engineGain > 0);
  assert.ok(other.engineGain > 0);
});

test("the occupied local boat is not doubled by spatial audio", () => {
  const sources = playerBoatAudioSources(createFreeWorld(), 0);
  assert.equal(sources.some(source => source.isOwn), false);
  assert.equal(sources.some(source => source.ownerIndex === 1), true);
});

test("boat sound fades continuously with distance", () => {
  const world = createFreeWorld();
  Object.assign(world.players[0], {mode: "swim", activeBoat: null, x: 200, y: 180});
  Object.assign(world.boats[0], {x: 210, y: 180, engineStalled: false});
  const near = playerBoatAudioSources(world, 0).find(source => source.isOwn);
  world.boats[0].x = 200 + PLAYER_BOAT_AUDIO_RANGES.own * 0.75;
  const far = playerBoatAudioSources(world, 0).find(source => source.isOwn);
  assert.ok(near.engineGain > far.engineGain);
  assert.ok(far.engineGain > 0);
  world.boats[0].x = 200 + PLAYER_BOAT_AUDIO_RANGES.own + 1;
  assert.equal(playerBoatAudioSources(world, 0).some(source => source.isOwn), false);
});

test("a stalled drifting boat produces wake but no motor", () => {
  const world = createFreeWorld();
  Object.assign(world.players[0], {mode: "swim", activeBoat: null, x: 200, y: 180});
  Object.assign(world.boats[0], {x: 210, y: 180, engineStalled: true, speed: 4});
  const source = playerBoatAudioSources(world, 0).find(candidate => candidate.isOwn);
  assert.equal(source.engineGain, 0);
  assert.ok(source.wakeGain > 0);
});

test("the live audio wrapper installs the spatial boat patch before use", async () => {
  const [quality, patch] = await Promise.all([
    readFile(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-player-boat-audio-v1.js", import.meta.url), "utf8"),
  ]);
  assert.match(quality, /import "\.\/free-roam-player-boat-audio-v1\.js\?v=1"/);
  assert.match(patch, /playerBoatLoops \|\|= new Map/);
  assert.match(patch, /setTargetAtTime\(source\.engineGain, now, 0\.22\)/);
  assert.match(patch, /setTargetAtTime\(0, now, 0\.22\)/);
});
