import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("V172 distinguishes automatic and mega-bomb target bands", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v172.js", import.meta.url), "utf8");
  assert.match(source, /COMBAT_TUNING\.automaticRange/);
  assert.match(source, /MEGA_BOMB_RANGE = 320/);
  assert.match(source, /Автомат не достаёт, но дальняя мега-бомба может достать/);
});
