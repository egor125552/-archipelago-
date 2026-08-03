import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("developer logger records events from authoritative websocket messages", () => {
  const logger = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v2.js", import.meta.url), "utf8");
  assert.match(logger, /if \(Array\.isArray\(message\.events\)\) captureServerEvents\(message\.events\)/);
  assert.match(logger, /append\("game-event", \{event\}\)/);
});
