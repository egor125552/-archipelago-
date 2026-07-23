import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {shouldHoldAutomaticFire, shouldHoldRangedFire} from "../public/src/free-roam-automatic-hold-v36.js";

test("three-finger hold fire accepts the pistol and automatic but not melee weapons", () => {
  assert.equal(shouldHoldRangedFire({pointers: 3, weaponText: "пистолет, 36"}), true);
  assert.equal(shouldHoldAutomaticFire({pointers: 3, weaponText: "автомат, 48"}), true);
  assert.equal(shouldHoldRangedFire({pointers: 2, weaponText: "пистолет, 36"}), false);
  assert.equal(shouldHoldRangedFire({pointers: 4, weaponText: "автомат, 48"}), false);
  assert.equal(shouldHoldRangedFire({pointers: 3, weaponText: "кулаки"}), false);
  assert.equal(shouldHoldRangedFire({pointers: 3, weaponText: "нож"}), false);
  assert.equal(shouldHoldRangedFire({pointers: 3, weaponText: "пистолет, 36", targetMenuOpen: true}), false);
});

test("the runtime presses and releases the existing attack control", async () => {
  const source = await readFile(new URL("../public/src/free-roam-automatic-hold-v36.js", import.meta.url), "utf8");
  assert.match(source, /activeTouches\.size === 3/);
  assert.match(source, /dispatchAttack\("pointerdown"\)/);
  assert.match(source, /dispatchAttack\("pointerup"\)/);
  assert.match(source, /activeTouches\.size !== 3/);
  assert.match(source, /targetMenuOpen/);
});
