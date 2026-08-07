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

test("ordinary motor cannot start on shore, in water, or for the armored boat", async () => {
  const [audioV2, audioV3, audioV4] = await Promise.all([
    readFile(new URL("../public/src/free-roam-audio-v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v3.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v4.js", import.meta.url), "utf8"),
  ]);

  assert.match(audioV2, /ORDINARY_LOCAL_ENGINE_LOOPS/);
  assert.match(audioV2, /ordinaryLocalEngineAllowed/);
  assert.match(audioV2, /ensureLoop\(name, options\)/);
  assert.match(audioV2, /isOrdinaryLocalEngine\(name\) && !this\.ordinaryLocalEngineAllowed/);
  assert.match(audioV2, /localBoat\.audioProfile !== "dual-turret"/);
  assert.match(audioV2, /stopOrdinaryLocalEngine\(\)/);
  assert.match(audioV3, /free-roam-audio-v2\.js\?v=39/);

  assert.match(audioV4, /const customEngine = otherBoat\?\.audioProfile === "dual-turret"/);
  assert.match(audioV4, /if \(!customEngine\) this\.startRemoteLoop\("remote", "motorboatReal"\)/);
  assert.match(audioV4, /customEngine \? 0 : engineGain/);
});

test("mounted turret always fires on attack and does not require a target", async () => {
  const weapons = await readFile(new URL("../public/src/free-roam-dual-turret-weapons.js", import.meta.url), "utf8");
  assert.doesNotMatch(weapons, /Цель вне сектора|поверни бронекатер|relative\s*[<>]=?\s*turret\./);
  assert.doesNotMatch(weapons, /Сначала выбери боевую цель/);
  assert.doesNotMatch(weapons, /combat\?\.equipped === DUAL_TURRET_WEAPON_ID && input\.attack/);
  assert.match(weapons, /const firing = Boolean\(mounted && input\.attack\)/);
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

test("worker server uses only the unified armored boat room API", async () => {
  const [server, core] = await Promise.all([
    readFile(new URL("../src/free-roam-server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(server, /prepareDualTurretPrototypeRoom|prepareDualTurretPurchaseRoom/);
  assert.match(server, /prepareDualTurretBoatRoom/);
  assert.match(core, /export \{prepareDualTurretBoatRoom\}/);
});

test("armored boat is normalized as owned after legacy first boarding", async () => {
  const core = await readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8");
  assert.match(core, /normalizeDualTurretOwnership/);
  assert.match(core, /if \(!Number\.isInteger\(boat\.owner\)\) boat\.owner = Number\.isInteger\(boat\.driver\) \? boat\.driver : playerIndex/);
  assert.match(core, /угнал чужую лодку/);
  assert.match(core, /на своём двухместном бронекатере/);
  assert.match(core, /event\.ownedBoat = true/);
});

test("heavy boat physics never scales down a sonar heading snap", async () => {
  const physics = await readFile(new URL("../public/src/free-roam-boat-physics.js", import.meta.url), "utf8");
  const core = await readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8");
  assert.match(physics, /"sonar-guide-snap"/);
  assert.match(physics, /if \(disruptiveForBoat\(world, boat, eventStart\)\)/);
  assert.match(core, /free-roam-boat-physics\.js\?v=2/);
});
