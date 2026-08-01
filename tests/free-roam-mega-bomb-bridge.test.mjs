import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("mega-bomb bridge sends a true/false zero-sequence pulse without replacing normal input", async () => {
  const source = await readFile(new URL("../public/src/free-roam-startup-v1.js", import.meta.url), "utf8");
  assert.match(source, /type:\s*"free-input", sequence:\s*0, input:\s*\{\.\.\.baseInput, megaBomb:\s*true\}/);
  assert.match(source, /type:\s*"free-input", sequence:\s*0, input:\s*baseInput/);
  assert.match(source, /lastFreeInput\s*=\s*\{\.\.\.message\.input, megaBomb:\s*false\}/);
  assert.doesNotMatch(source, /room\s*[:=].*megaBomb/);
});
