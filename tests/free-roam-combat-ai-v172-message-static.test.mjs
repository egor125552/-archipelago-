import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("target messages distinguish alive, direct-fire range and bomb range", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v172.js", import.meta.url), "utf8");
  assert.match(source, /Цель жива и захвачена/);
  assert.match(source, /Даже мега-бомба действует только до/);
});
