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

test("automatic session return is opt-in through the saved interface setting", async () => {
  const source = await read("../public/src/free-roam-startup-v1.js");
  assert.match(source, /echo-free-roam-interface-settings-v1/);
  assert.match(source, /settings\?\.autoResume === true/);
  assert.match(source, /if \(autoResumeEnabled\(\)\)/);
  assert.match(source, /autoResumeEnabled,/);
});

test("touch gameplay receives gesture wording while desktop key guidance remains on the server", async () => {
  const source = await read("../public/src/free-roam-startup-v1.js");
  const scenario = await read("../public/src/free-roam-scenario.js");
  assert.match(source, /navigator\.maxTouchPoints/);
  assert.match(source, /\(pointer: coarse\)/);
  assert.match(source, /Коснись двумя пальцами/);
  assert.match(source, /коснись экрана одним пальцем/);
  assert.match(source, /event\.text\.includes\("Сонар Q"\)/);
  assert.match(source, /event\.text\.includes\("нажми F"\)/);
  assert.match(scenario, /Сонар Q называет одну цель/);
  assert.match(scenario, /нажми F/);
});

test("a targeted reconnect refuses a replacement world and retries the old room", async () => {
  const source = await read("../public/src/free-roam-startup-v1.js");
  assert.match(source, /preferredRoomFound !== true/);
  assert.match(source, /message\.room !== requestedRoom/);
  assert.match(source, /message\.role !== requestedRole/);
  assert.match(source, /retry-preferred-room/);
  assert.match(source, /reconnectRetry: true/);
  assert.match(source, /if \(retryingPreferredRoom\) return null/);
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

test("startup preference guard runs before the game and watchdog runs after input bindings", async () => {
  const html = await read("../public/free-roam.html");
  const startup = html.indexOf("free-roam-startup-v1.js?v=5");
  const settings = html.indexOf("free-roam-settings-v1.js?v=2");
  const game = html.search(/free-roam-v4\.js\?v=\d+/);
  const holdFire = html.indexOf("free-roam-automatic-hold-v36.js?v=4");
  const accessibility = html.indexOf("free-roam-accessibility.js?v=1");
  const watchdog = html.indexOf("free-roam-gesture-watchdog-v1.js?v=1");

  assert.ok(startup >= 0 && startup < settings);
  assert.ok(settings >= 0 && settings < game);
  assert.ok(game >= 0 && game < holdFire);
  assert.ok(accessibility >= 0 && accessibility < watchdog);
});
