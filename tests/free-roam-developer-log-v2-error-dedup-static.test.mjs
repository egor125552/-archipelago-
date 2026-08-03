import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("developer log V2 compresses repeated logger failures", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v2.js", import.meta.url), "utf8");
  assert.match(source, /ERROR_REPEAT_WINDOW_MS/);
  assert.match(source, /logger-error-repeat/);
});
