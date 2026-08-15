import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("own movement audio is centered and remote movement remains positional", async () => {
  const audio = await readFile(new URL("../public/src/free-roam-audio-v4.js", import.meta.url), "utf8");
  assert.match(audio, /if \(local\) \{[\s\S]*?pan = 0;/);
  assert.doesNotMatch(audio, /movementPan\) \|\| 0[\s\S]*?0\.56/);
  assert.match(audio, /pan = relativeMovementPan\(listener, event\)/);
});

test("seated player is represented by the boat target", async () => {
  const targeting = await readFile(new URL("../public/src/free-roam-targeting.js", import.meta.url), "utf8");
  assert.match(targeting, /protectedByBoat = player\?\.mode === "boat" && boat/);
  assert.match(targeting, /&& !protectedByBoat/);
  assert.match(targeting, /бронекатер игрока/);
  assert.match(targeting, /броня \$\{Math\.round/);
});

test("mega bomb foot spatialization is world-coordinate based and armor aware", async () => {
  const [entry, bomb] = await Promise.all([
    readFile(new URL("../src/free-roam-mega-bomb.js", import.meta.url), "utf8"),
    readFile(new URL("../src/free-roam-mega-bomb-v38.js", import.meta.url), "utf8"),
  ]);
  assert.match(entry, /free-roam-mega-bomb-v38\.js\?v=2/);
  assert.match(bomb, /worldSpacePan\(listener, event\)/);
  assert.match(bomb, /nominalArmorDamage = raw \* 0\.72/);
  assert.match(bomb, /state\.hull = clamp\(state\.hull - hullDamage, 0, state\.hullMax\)/);
});

test("player gunfire respects armored patrol durability", async () => {
  const core = await readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8");
  assert.match(core, /captureDualTurretDurability/);
  assert.match(core, /rebalanceDualTurretGunHits/);
  assert.match(core, /nominalArmorDamage = nominalHullDamage \* 1\.45/);
  assert.match(core, /state\.hull = clamp\(state\.hull - hullDamage, 0\.05, state\.hullMax\)/);
  assert.match(core, /Твой бронекатер под огнём/);
});
