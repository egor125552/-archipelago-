import test from "node:test";
import assert from "node:assert/strict";

import {
  installTargetMenuSpeechGateBypass,
  isTargetMenuSpeech,
  targetMenuAwareSpeechAllowed,
} from "../public/src/free-roam-target-speech-policy.js";

function combatSpamGate(text) {
  const value = String(text || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  return !(/здоровье \d|прочность \d|осталось \d/.test(value));
}

test("manual target menu speech bypasses combat status filtering", () => {
  const turret = "Боевая цель. Цель 2 из 3: тяжёлая оружейная установка, 42 метра, прочность 240.";
  const gunner = "Боевая цель. Цель 4 из 8: вражеский автоматчик, 31 метр, здоровье 80.";

  assert.equal(combatSpamGate(turret), false, "the legacy combat filter reproduces the bug");
  assert.equal(combatSpamGate(gunner), false, "health-bearing target descriptions also reproduce it");
  assert.equal(isTargetMenuSpeech(turret), true);
  assert.equal(isTargetMenuSpeech(gunner), true);
  assert.equal(targetMenuAwareSpeechAllowed(combatSpamGate, turret), true);
  assert.equal(targetMenuAwareSpeechAllowed(combatSpamGate, gunner), true);
});

test("automatic combat status remains filtered", () => {
  const automatic = "Попадание по установке. Прочность 120.";
  assert.equal(isTargetMenuSpeech(automatic), false);
  assert.equal(targetMenuAwareSpeechAllowed(combatSpamGate, automatic), false);
});

test("installed target gate preserves the original policy outside target menu", () => {
  const target = {__echoFreeRoamSpeechAllowed: combatSpamGate};
  assert.equal(installTargetMenuSpeechGateBypass(target), true);
  assert.equal(target.__echoFreeRoamSpeechAllowed("Боевая цель. Цель 1 из 2: двигатель, 18 метров, прочность 90."), true);
  assert.equal(target.__echoFreeRoamSpeechAllowed("Попадание. Осталось 50."), false);
  assert.equal(installTargetMenuSpeechGateBypass(target), true, "install is idempotent");
});
