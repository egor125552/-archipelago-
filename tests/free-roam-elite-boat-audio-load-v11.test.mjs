import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("elite bomb-bay audio is loaded through the live Safari cache chain", () => {
  const html = fs.readFileSync(new URL("../public/free-roam.html", import.meta.url), "utf8");
  const quality = fs.readFileSync(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8");
  const eliteAudio = fs.readFileSync(new URL("../public/src/free-roam-elite-boat-audio-v11.js", import.meta.url), "utf8");

  assert.match(html, /free-roam-quality-v1\.js\?v=6/);
  assert.match(quality, /free-roam-elite-boat-audio-v11\.js\?v=1/);
  assert.match(eliteAudio, /free-roam-audio-v5\.js\?v=44/);
  assert.match(eliteAudio, /elite-bomb-bay-opening/);
  assert.match(eliteAudio, /elite-bomb-bay-closing/);
  assert.match(eliteAudio, /elite-bomb-bay-closed/);
  assert.doesNotMatch(eliteAudio, /AudioContext\s*\(|\.destination\b/);
});
