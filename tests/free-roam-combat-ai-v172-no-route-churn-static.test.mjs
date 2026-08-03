import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("V172 persists one stable repair destination", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v172.js", import.meta.url), "utf8");
  assert.match(source, /stableRepairDestination/);
  assert.match(source, /heavy\.destination = \{\.\.\.state\.stableRepairDestination\}/);
});
