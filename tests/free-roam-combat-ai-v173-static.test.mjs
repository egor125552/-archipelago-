import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("authoritative hotfix reaches V173", () => {
  const hotfix = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-hotfix-v163.js", import.meta.url), "utf8");
  assert.match(hotfix, /free-roam-combat-ai-model-v173\.js\?v=1/);
  assert.match(hotfix, /applyCombatAiModelV173/);
});
