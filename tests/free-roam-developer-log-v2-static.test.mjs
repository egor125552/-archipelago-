import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("developer log V2 captures authoritative server events and loads through V1 entry", () => {
  const logger = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v2.js", import.meta.url), "utf8");
  const entry = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v1.js", import.meta.url), "utf8");
  assert.match(logger, /captureServerEvents/);
  assert.match(logger, /class LoggedWebSocket extends NativeWebSocket/);
  assert.match(logger, /logger-error-repeat/);
  assert.match(entry, /free-roam-developer-log-v2\.js\?v=3/);
});
