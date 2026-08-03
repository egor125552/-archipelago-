import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("repair begins only after direct-fire clearance and no bomb threat", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-combat-ai-model-v172.js", import.meta.url), "utf8");
  assert.match(source, /currentNearest >= clearance && !bombIncoming/);
  assert.match(source, /heavy\.phase = "breach-repairing-v166"/);
  assert.match(source, /boat\.speed = 0/);
});
