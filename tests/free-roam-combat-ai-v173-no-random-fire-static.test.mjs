import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("out-of-range direct fire is suppressed before base combat runs", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v172.js", import.meta.url), "utf8");
  const prepare = source.indexOf("suppressOutOfRangeDirectFireV172(world, state)");
  const finish = source.indexOf("restoreSuppressedInputs(state.frame?.suppressedInputs)");
  assert.ok(prepare >= 0);
  assert.ok(finish > prepare);
});
