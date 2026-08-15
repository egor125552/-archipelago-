import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("developer log v4 keeps server sequence gaps compact", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v4.js", import.meta.url), "utf8");
  const entry = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v1.js", import.meta.url), "utf8");

  assert.match(source, /const MAX_INCIDENTS = 4;/);
  assert.match(source, /const MAX_BLACK_BOX = 3000;/);
  assert.match(source, /compressedTicks: gap/);
  assert.doesNotMatch(source, /freezeBlackBox\("server-sequence-gap"/);
  assert.match(source, /freezeBlackBox\("javascript-error"/);
  assert.match(source, /freezeBlackBox\("promise-rejection"/);
  assert.match(source, /activeEntitySnapshots\(current\)\.map\(snapshot => compactLogValue\(snapshot\)\)/);
  assert.match(entry, /free-roam-developer-log-v4\.js\?v=1/);
});
