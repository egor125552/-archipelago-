import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {likelyCargoAction} from "../public/src/free-roam-sharp-feedback-v1.js";

test("cargo feedback only fires for a real nearby cargo interaction", () => {
  const world = {
    players: [{mode: "foot", x: 10, y: 10, combat: {alive: true, carriedCrate: null}}],
    boats: [{id: 0, x: 80, y: 80, cargo: [], sunk: false}],
    freeActivities: {crates: [{id: "near", x: 20, y: 10, state: "world"}]},
  };
  assert.equal(likelyCargoAction(world, 0), true);
  world.freeActivities.crates[0].x = 40;
  assert.equal(likelyCargoAction(world, 0), false);
  world.players[0].combat.carriedCrate = "near";
  assert.equal(likelyCargoAction(world, 0), true);
});

test("boat cargo and steal range count as cargo actions", () => {
  const world = {
    players: [{mode: "boat", activeBoat: 0, x: 20, y: 20, combat: {alive: true, carriedCrate: null}}],
    boats: [{id: 0, x: 20, y: 20, cargo: ["crate"], sunk: false}],
    freeActivities: {crates: []},
  };
  assert.equal(likelyCargoAction(world, 0), true);

  world.players[0].mode = "foot";
  world.players[0].activeBoat = null;
  world.players[0].x = 27;
  world.boats[0].x = 20;
  assert.equal(likelyCargoAction(world, 0), true);
  world.players[0].x = 40;
  assert.equal(likelyCargoAction(world, 0), false);
});

test("live audio wrappers patch the exact class used by the client", async () => {
  const [client, pistol, sharp] = await Promise.all([
    readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-pistol-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-sharp-feedback-v1.js", import.meta.url), "utf8"),
  ]);
  assert.match(client, /free-roam-audio-v5\.js\?v=44/);
  assert.match(pistol, /free-roam-audio-v5\.js\?v=44/);
  assert.match(sharp, /free-roam-audio-v5\.js\?v=44/);
  assert.match(pistol, /free-roam-sharp-feedback-v1\.js\?v=1/);
});

test("decisive sounds bypass the injury path and delayed duplicates are suppressed", async () => {
  const source = await readFile(new URL("../public/src/free-roam-sharp-feedback-v1.js", import.meta.url), "utf8");
  assert.match(source, /sharpTransientBus\.connect\(this\.compressor\)/);
  assert.match(source, /localSharpJumpUntil/);
  assert.match(source, /localSharpAttackUntil/);
  assert.match(source, /localSharpCargoUntil/);
  assert.match(source, /playSharpCombatImpact/);
  assert.match(source, /event\.code === "KeyX"/);
  assert.match(source, /event\.code === "KeyF"/);
});
