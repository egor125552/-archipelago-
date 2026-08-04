import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("authoritative hotfix uses one heavy controller instead of the V164-V176 layer chain", () => {
  const hotfix = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-hotfix-v163.js", import.meta.url), "utf8");
  const controller = fs.readFileSync(new URL("../public/src/free-roam-heavy-ai-controller-v1.js", import.meta.url), "utf8");
  const support = fs.readFileSync(new URL("../public/src/free-roam-heavy-ai-support-v1.js", import.meta.url), "utf8");
  const memory = fs.readFileSync(new URL("../public/src/free-roam-heavy-hull-damage-memory-v1.js", import.meta.url), "utf8");

  assert.match(hotfix, /free-roam-heavy-ai-controller-v1\.js\?v=3/);
  assert.match(hotfix, /free-roam-heavy-hull-damage-memory-v1\.js\?v=1/);
  assert.match(hotfix, /prepareHeavyAiControllerV1\(world\)/);
  assert.match(hotfix, /captureHeavyHullDamageCarryoverV1\(world\)/);
  assert.match(hotfix, /finishHeavyAiControllerV1\(world,dt\)/);
  assert.match(hotfix, /finalizeHeavyHullDamageCarryoverV1\(world\)/);
  assert.doesNotMatch(hotfix, /free-roam-combat-ai-model-v1(?:6[4-9]|7[0-6])\.js/);
  assert.doesNotMatch(controller, /free-roam-combat-ai-model-v1(?:6[4-9]|7[0-6])\.js/);
  assert.doesNotMatch(support, /heavy\.phase\s*=/);
  assert.doesNotMatch(memory, /heavy\.phase\s*=/);
});
