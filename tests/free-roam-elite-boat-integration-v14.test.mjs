import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {createFreeWorld, setPlayerPresence} from "../public/src/free-roam-core-v6.js";
import {
  eliteBossCombatTargets,
  ensureEliteBoatBoss,
  startEliteBoatBoss,
} from "../public/src/free-roam-elite-boat.js";

function bossWorld() {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  setPlayerPresence(world, 0, true);
  setPlayerPresence(world, 1, false);
  world.players[0].combat.alive = true;
  world.players[0].mode = "boat";
  world.players[0].activeBoat = world.boats[0].id;
  const state = startEliteBoatBoss(world, 91, {x: 210, y: 180}, 0);
  state.phase = "boat-combat";
  return {world, state};
}

test("legacy elite side-layer fields migrate inside the authoritative boss file", () => {
  const world = createFreeWorld();
  world.freeEliteBossTacticsV12 = {legacy: true};
  world.freeEliteBossJournalTactics = {legacy: true};
  ensureEliteBoatBoss(world);
  assert.equal(Object.hasOwn(world, "freeEliteBossTacticsV12"), false);
  assert.equal(Object.hasOwn(world, "freeEliteBossJournalTactics"), false);
});

test("bomb bay identity stays stable and it is a real combat target", () => {
  const {world, state} = bossWorld();
  const bombBay = state.bombBay;
  ensureEliteBoatBoss(world);
  assert.equal(state.bombBay, bombBay);
  assert.equal(state.boat.bombBay, bombBay);
  state.bombBayState = "open";
  state.bombBay.state = "open";
  state.bombBay.exposed = true;
  state.boat.bombBayState = "open";
  const target = eliteBossCombatTargets(world, 0).find(candidate => candidate.component === "bomb-bay");
  assert.ok(target);
  assert.equal(target.kind, "eliteBombBay");
  assert.equal(target.point, state.boat);
  assert.equal(target.point.turrets.length, 2);
});

test("elite projectile audio follows replicated state and has guaranteed cleanup", async () => {
  const [audio, baseAudio, combat, combatV2, targeting, server, bomb] = await Promise.all([
    readFile(new URL("../public/src/free-roam-elite-boat-audio-v11.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v5.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-combat.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-combat-v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-targeting.js", import.meta.url), "utf8"),
    readFile(new URL("../src/free-roam-server.js", import.meta.url), "utf8"),
    readFile(new URL("../src/free-roam-mega-bomb-v37.js", import.meta.url), "utf8"),
  ]);
  assert.match(baseAudio, /trackedId/);
  assert.match(audio, /eliteBulletVoices/);
  assert.match(audio, /projectile\.x/);
  assert.match(audio, /projectile\.y/);
  assert.match(audio, /projectile\.vx/);
  assert.match(audio, /projectile\.vy/);
  assert.match(audio, /projectile\.energy/);
  assert.match(audio, /relativeMovementPan\(listener, projectile\)/);
  assert.match(audio, /prototype\.stopAll/);
  assert.match(audio, /marauderEngine\.trackedId/);
  assert.doesNotMatch(audio, /projectile\.x\s*\+=|projectile\.y\s*\+=/);
  assert.match(combat, /"eliteBombBay"/);
  assert.match(combatV2, /"eliteBombBay"/);
  assert.doesNotMatch(targeting, /normalizeEliteBossCollections/);
  assert.doesNotMatch(server, /delete world\.freeEliteBossTacticsV12/);
  assert.match(bomb, /hostileRespawnGraceActive/);
});
