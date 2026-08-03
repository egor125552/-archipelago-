import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("developer log V2 records outgoing free-input packets", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v2.js", import.meta.url), "utf8");
  assert.match(source, /message\.type === "free-input"/);
  assert.match(source, /client-input-packet/);
});
