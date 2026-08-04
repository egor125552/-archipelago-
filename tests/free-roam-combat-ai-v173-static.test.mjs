import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("authoritative hotfix reaches V176 while preserving V175, V174 and V173 layers", () => {
  const hotfix = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-hotfix-v163.js", import.meta.url), "utf8");
  const v176 = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v176.js", import.meta.url), "utf8");
  const v175 = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v175.js", import.meta.url), "utf8");
  const v174 = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v174.js", import.meta.url), "utf8");
  assert.match(hotfix, /free-roam-combat-ai-model-v176\.js\?v=1/);
  assert.match(hotfix, /applyCombatAiModelV176/);
  assert.match(v176, /free-roam-combat-ai-model-v175\.js\?v=1/);
  assert.match(v176, /applyCombatAiModelV175/);
  assert.match(v175, /free-roam-combat-ai-model-v174\.js\?v=1/);
  assert.match(v175, /applyCombatAiModelV174/);
  assert.match(v174, /free-roam-combat-ai-model-v173\.js\?v=1/);
  assert.match(v174, /applyCombatAiModelV173/);
});
