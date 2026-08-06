import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {fireDualTurretHitscan} from "../public/src/free-roam-dual-turret-projectiles.js";
import {DUAL_TURRET_DEFINITIONS} from "../public/src/free-roam-dual-turret-config.js";

test("merchant action has priority over nearby armored boarding", async () => {
  const core = await readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8");
  assert.match(core, /merchantOwnsAction/);
  assert.match(core, /isPlayerNearMerchant/);
  assert.match(core, /prepareFreeRoamPlayerInput/);
  assert.match(core, /merchantOwnsAction\(world, playerIndex, nextInput\)/);
});

test("ordinary local engine is stopped on foot, in water, and aboard armored boat", async () => {
  const [audioV2, audioV3] = await Promise.all([
    readFile(new URL("../public/src/free-roam-audio-v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v3.js", import.meta.url), "utf8"),
  ]);
  assert.match(audioV2, /ORDINARY_LOCAL_ENGINE_LOOPS/);
  assert.match(audioV2, /!ordinaryBoatAboard/);
  assert.match(audioV2, /stopOrdinaryLocalEngine\(\)/);
  assert.match(audioV3, /free-roam-audio-v2\.js\?v=39/);
});

test("turret sector mechanics are removed and empty fire has a real heading", async () => {
  const weapons = await readFile(new URL("../public/src/free-roam-dual-turret-weapons.js", import.meta.url), "utf8");
  assert.doesNotMatch(weapons, /Цель вне сектора|поверни бронекатер|relative\s*[<>]=?\s*turret\./);
  assert.doesNotMatch(weapons, /Сначала выбери боевую цель/);
  assert.match(weapons, /automaticHostileTarget/);
  assert.match(weapons, /target-auto-locked/);
  assert.ok(DUAL_TURRET_DEFINITIONS.every(definition => !("minimumRelativeHeading" in definition) && !("maximumRelativeHeading" in definition)));

  const world = {time: 1, events: [], freeDualTurretBoat: {nextShotId: 1}};
  const shot = fireDualTurretHitscan(world, {
    boat: {id: 2, x: 100, y: 100, heading: 0},
    turret: {id: "left", side: -1},
    sourcePlayer: 0,
    heading: 90,
    target: null,
  });
  assert.ok(Math.hypot(shot.impactX - shot.x, shot.impactY - shot.y) > 600);
  assert.equal(world.events.at(-1)?.reason, "no-target");
});
