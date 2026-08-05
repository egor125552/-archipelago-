import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

function looksLikeMp3(bytes) {
  const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return id3 || frame;
}

test("release explosion and kill cue are complete direct MP3 files", async () => {
  const explosion = await readFile(new URL("../public/audio/mega-bomb-explosion-v12.mp3", import.meta.url));
  const kill = await readFile(new URL("../public/audio/enemy-killed-v5.mp3", import.meta.url));
  assert.ok(explosion.byteLength > 50_000);
  assert.ok(kill.byteLength > 1_000);
  assert.equal(looksLikeMp3(explosion), true);
  assert.equal(looksLikeMp3(kill), true);
});

test("release client contains no browser-side audio reconstruction", async () => {
  const source = await readFile(
    new URL("../public/src/free-roam-mega-bomb-client-v25.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /mega-bomb-explosion-v12\.mp3/);
  assert.doesNotMatch(source, /\.part-|\.b64|atob|Uint8Array/);
});
