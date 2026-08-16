import test from "node:test";
import assert from "node:assert/strict";

import {CURRENT_VESSEL_TYPES} from "../public/src/vessel/definitions/current-vessels.js";
import {mountedWeaponDamageAtDistance} from "../public/src/vessel/systems/vessel-mounted-weapon-system.js";
import {STRESS_TEST_VESSEL_TYPE} from "../public/src/vessel/stress-test-vessel-config.js";

test("stress pistol keeps rapid fire but loses damage with distance", () => {
  const vessel = CURRENT_VESSEL_TYPES.find(definition => definition.id === STRESS_TEST_VESSEL_TYPE);
  const pistol = vessel?.modules?.find(module => module.id === "stress-pistol");
  assert.ok(pistol);

  const config = pistol.config;
  assert.equal(config.damage, 6);
  assert.equal(config.interval, 0.04);
  assert.equal(config.range, 320);
  assert.equal(config.fullDamageRange, 55);
  assert.equal(config.damageFalloffEndRange, 220);
  assert.equal(config.minimumDamageMultiplier, 0.2);

  assert.equal(mountedWeaponDamageAtDistance(config, config.damage, 0), 6);
  assert.equal(mountedWeaponDamageAtDistance(config, config.damage, 55), 6);
  assert.equal(mountedWeaponDamageAtDistance(config, config.damage, 100), 4.69);
  assert.equal(mountedWeaponDamageAtDistance(config, config.damage, 150), 3.24);
  assert.equal(mountedWeaponDamageAtDistance(config, config.damage, 220), 1.2);
  assert.equal(mountedWeaponDamageAtDistance(config, config.damage, 320), 1.2);

  assert.equal(config.damage / config.interval, 150);
  assert.equal(mountedWeaponDamageAtDistance(config, config.damage, 220) / config.interval, 30);
});

test("mounted weapons without falloff settings keep their old damage", () => {
  assert.equal(mountedWeaponDamageAtDistance({}, 12, 300), 12);
  assert.equal(mountedWeaponDamageAtDistance({fullDamageRange: 50}, 9, 300), 9);
});
