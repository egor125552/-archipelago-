import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("Safari receives a new outer module URL for the restored boat audio patch", async () => {
  const [html, quality, boatAudio] = await Promise.all([
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-player-boat-audio-v1.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /free-roam-quality-v1\.js\?v=7/);
  assert.match(quality, /free-roam-player-boat-audio-v1\.js\?v=3/);
  assert.match(boatAudio, /free-roam-audio-v5\.js\?v=45/);
});
