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

test("ordinary motor is suppressed whenever the current vessel owns a dedicated engine", async () => {
  const [audioV2, audioV3, audioV4] = await Promise.all([
    readFile(new URL("../public/src/free-roam-audio-v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v3.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v4.js", import.meta.url), "utf8"),
  ]);

  assert.match(audioV2, /ORDINARY_LOCAL_ENGINE_LOOPS/);
  assert.match(audioV2, /hasDedicatedVesselEngine/);
  assert.match(audioV2, /profile\.startsWith\("dual-turret"\)/);
  assert.match(audioV2, /profile\.startsWith\("medium-crew"\)/);
  assert.match(audioV2, /isOrdinaryLocalEngine\(name\) && !this\.ordinaryLocalEngineAllowed/);
  assert.match(audioV2, /!hasDedicatedVesselEngine\(localBoat\)/);
  assert.match(audioV2, /stopOrdinaryLocalEngine\(\)/);
  assert.match(audioV3, /free-roam-audio-v2\.js\?v=41/);
  assert.match(audioV3, /free-roam-audio-spatial\.js\?v=1/);

  assert.match(audioV4, /customVesselEngine/);
  assert.match(audioV4, /profile\.startsWith\("dual-turret"\)/);
  assert.match(audioV4, /profile\.startsWith\("medium-crew"\)/);
  assert.match(audioV4, /if \(!customEngine\) this\.startRemoteLoop\("remote", "motorboatReal"\)/);
  assert.match(audioV4, /customEngine \? 0 : engineGain/);
});

test("local footsteps stay centered while remote movement stays spatial", async () => {
  const audioV4 = await readFile(new URL("../public/src/free-roam-audio-v4.js", import.meta.url), "utf8");
  assert.match(audioV4, /if \(local\) \{[\s\S]*?pan = 0;/);
  assert.doesNotMatch(audioV4, /side \* 0\.56/);
  assert.match(audioV4, /pan = relativeMovementPan\(listener, event\)/);
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

test("armored boat first boarding is normalized as owned without depending on announcement grammar", async () => {
  const core = await readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8");
  assert.match(core, /normalizeDualTurretOwnership/);
  assert.match(core, /if \(!Number\.isInteger\(boat\.owner\)\) boat\.owner = Number\.isInteger\(boat\.driver\) \? boat\.driver : playerIndex/);
  assert.match(core, /угнал чужую лодку/);
  assert.match(core, /event\.boatId = boat\.id/);
  assert.match(core, /event\.ownedBoat = true/);
});

test("heavy boat physics never scales down a sonar heading snap", async () => {
  const physics = await readFile(new URL("../public/src/free-roam-boat-physics.js", import.meta.url), "utf8");
  const core = await readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8");
  assert.match(physics, /"sonar-guide-snap"/);
  assert.match(physics, /if \(disruptiveForBoat\(world, boat, eventStart\)\)/);
  assert.match(core, /free-roam-boat-physics\.js\?v=2/);
});

test("a player seated inside a boat collapses to the vehicle target", async () => {
  const targeting = await readFile(new URL("../public/src/free-roam-targeting.js", import.meta.url), "utf8");
  assert.match(targeting, /const protectedByBoat = player\?\.mode === "boat" && boat/);
  assert.match(targeting, /&& !protectedByBoat/);
  assert.match(targeting, /бронекатер игрока/);
  assert.match(targeting, /seenBoatIds/);
  assert.match(targeting, /броня \$\{Math\.round\(target\.point\?\.armor/);
});

test("mega bomb uses world coordinates on foot and armor before structural hull", async () => {
  const [entry, v38] = await Promise.all([
    readFile(new URL("../src/free-roam-mega-bomb.js", import.meta.url), "utf8"),
    readFile(new URL("../src/free-roam-mega-bomb-v38.js", import.meta.url), "utf8"),
  ]);
  assert.match(entry, /free-roam-mega-bomb-v38\.js\?v=2/);
  assert.match(v38, /\["foot", "swim"\]\.includes\(player\.mode\)/);
  assert.match(v38, /event\.spatial\[index\]\.pan = worldSpacePan\(listener, event\)/);
  assert.match(v38, /nominalArmorDamage = raw \* 0\.72/);
  assert.match(v38, /state\.hull = clamp\(state\.hull - hullDamage, 0, state\.hullMax\)/);
  assert.match(v38, /Мега-бомба ударила по бронекатеру/);
});
