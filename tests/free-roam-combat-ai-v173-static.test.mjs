import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("authoritative hotfix reaches V174 while preserving the V173 layer", () => {
  const hotfix = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-hotfix-v163.js", import.meta.url), "utf8");
  const v174 = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v174.js", import.meta.url), "utf8");
  assert.match(hotfix, /free-roam-combat-ai-model-v174\.js\?v=1/);
  assert.match(hotfix, /applyCombatAiModelV174/);
  assert.match(v174, /free-roam-combat-ai-model-v173\.js\?v=1/);
  assert.match(v174, /applyCombatAiModelV173/);
});
