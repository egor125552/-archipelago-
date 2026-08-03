import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("authoritative server applies the combat hotfix before and after each step", () => {
  const server = fs.readFileSync(new URL("../src/free-roam-server.js", import.meta.url), "utf8");
  assert.match(server, /applyAuthoritativeCombatHotfix\(world, 0\)/);
  assert.match(server, /stepFreeWorld\(world, chunk\)/);
  assert.match(server, /applyAuthoritativeCombatHotfix\(world, chunk\)/);
  assert.match(server, /free-roam-combat-ai-hotfix-v163\.js\?v=1/);
});
