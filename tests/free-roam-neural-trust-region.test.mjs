import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../training/train_selfplay_policy.py", import.meta.url), "utf8");

test("paired self-play projects every optimizer step into the configured trust region", () => {
  assert.match(source, /def project_to_trust_region\(/);
  assert.match(source, /optimizer\.step\(\)[\s\S]*project_to_trust_region\(model, base_state, args\.maximum_drift\)/);
  assert.match(source, /maximum_drift \* 0\.995/);
  assert.match(source, /trustRegionProjectionCount/);
  assert.match(source, /Trust-region bug:/);
});
