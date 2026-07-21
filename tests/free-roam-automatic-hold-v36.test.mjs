import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {shouldHoldAutomaticFire} from "../public/src/free-roam-automatic-hold-v36.js";

test("automatic hold fire requires exactly three fingers and the automatic weapon", () => {
  assert.equal(shouldHoldAutomaticFire({pointers: 3, weaponText: "автомат, 48"}), true);
  assert.equal(shouldHoldAutomaticFire({pointers: 2, weaponText: "автомат, 48"}), false);
  assert.equal(shouldHoldAutomaticFire({pointers: 4, weaponText: "автомат, 48"}), false);
  assert.equal(shouldHoldAutomaticFire({pointers: 3, weaponText: "кулаки"}), false);
  assert.equal(shouldHoldAutomaticFire({pointers: 3, weaponText: "нож"}), false);
  assert.equal(shouldHoldAutomaticFire({pointers: 3, weaponText: "автомат, 48", targetMenuOpen: true}), false);
});

test("the runtime presses and releases the existing attack control", async () => {
  const source = await readFile(new URL("../public/src/free-roam-automatic-hold-v36.js", import.meta.url), "utf8");
  assert.match(source, /activeTouches\.size === 3/);
  assert.match(source, /dispatchAttack\("pointerdown"\)/);
  assert.match(source, /dispatchAttack\("pointerup"\)/);
  assert.match(source, /activeTouches\.size !== 3/);
  assert.match(source, /targetMenuOpen/);
});
