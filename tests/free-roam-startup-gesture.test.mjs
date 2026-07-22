import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("stale VoiceOver speech preference is migrated back to the enabled default once", async () => {
  const source = await read("../public/src/free-roam-startup-v1.js");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /echo-free-roam-speech-default-v2/);
  assert.match(source, /localStorage\.getItem\(SPEECH_PREFERENCE_KEY\) === "off"/);
  assert.match(source, /localStorage\.removeItem\(SPEECH_PREFERENCE_KEY\)/);
  assert.match(source, /localStorage\.setItem\(SPEECH_DEFAULT_MIGRATION_KEY, "done"\)/);
});

test("gesture watchdog records and repairs stale pointer state", async () => {
  const source = await read("../public/src/free-roam-gesture-watchdog-v1.js");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /lostpointercapture/);
  assert.match(source, /event\.isPrimary && activePointers\.size/);
  assert.match(source, /new PointerEvent\("pointercancel"/);
  assert.match(source, /control-mode-recovery/);
  assert.match(source, /echo-free-roam-gesture-last-report-v1/);
  assert.match(source, /Скопировать сбой жестов/);
});

test("startup migration runs before the game and watchdog runs after input bindings", async () => {
  const html = await read("../public/free-roam.html");
  const startup = html.indexOf("free-roam-startup-v1.js?v=3");
  const game = html.indexOf("free-roam-v4.js?v=43");
  const accessibility = html.indexOf("free-roam-accessibility.js?v=1");
  const watchdog = html.indexOf("free-roam-gesture-watchdog-v1.js?v=1");

  assert.ok(startup >= 0 && startup < game);
  assert.ok(accessibility >= 0 && accessibility < watchdog);
});
