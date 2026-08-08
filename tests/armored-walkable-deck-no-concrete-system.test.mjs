import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("shared walkable vessel system contains no concrete armored vessel type branch", async () => {
  const source = await readFile(new URL("../public/src/vessel/systems/walkable-vessel-system.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /dual-turret-patrol|armored-main-deck|armored-helm-console/);
  assert.doesNotMatch(source, /(?:boatType|vesselType)\s*(?:===|!==)\s*["']/);
});
