import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("all active player-boat audio entrypoints use the same FreeRoamAudio class", async () => {
  const [boatAudio, quality, main] = await Promise.all([
    readFile(new URL("../public/src/free-roam-player-boat-audio-v1.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8"),
  ]);
  assert.match(boatAudio, /free-roam-audio-v5\.js\?v=44/);
  assert.match(quality, /free-roam-audio-v5\.js\?v=44/);
  assert.match(main, /free-roam-audio-v5\.js\?v=44/);
});
