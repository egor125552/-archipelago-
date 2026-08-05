import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("elite boat 1.1 documentation fixes bomb-bay and grace semantics", async () => {
  const text = await readFile(new URL("../docs/design/elite-boat-boss-1.1-amendment.md", import.meta.url), "utf8");
  assert.match(text, /closed → opening → open/);
  assert.match(text, /пять секунд перезарядки/);
  assert.match(text, /graceUntil/);
  assert.match(text, /заднюю половину цели/);
  assert.match(text, /переднюю/);
});
