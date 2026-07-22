import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("free-roam settings move risky toggles behind a dedicated menu", async () => {
  const [html, script, css] = await Promise.all([
    read("../public/free-roam.html"),
    read("../public/src/free-roam-settings-v1.js"),
    read("../public/free-roam.css"),
  ]);

  assert.match(html, /id="lobbySettingsButton"[^>]*>Настройки</);
  assert.match(html, /id="gameSettingsButton"[^>]*>Настройки</);
  assert.match(html, /id="settingsPanel"[^>]*role="dialog"/);
  assert.match(html, />Внешний вид</);
  assert.match(html, />Озвучка</);
  assert.match(html, /id="controlModeButton"[^>]*hidden/);
  assert.match(html, /id="speechButton"[^>]*hidden/);
  assert.match(html, /free-roam-settings-v1\.js\?v=1/);

  assert.match(script, /echo-free-roam-interface-settings-v1/);
  assert.match(script, /quickControl:\s*false/);
  assert.match(script, /quickSpeech:\s*false/);
  assert.match(script, /globalThis\.__freeRoam/);
  assert.match(script, /settingsGameButtonsButton/);
  assert.match(script, /settingsSpeechButton/);
  assert.match(script, /settingsQuickSpeechButton/);
  assert.doesNotMatch(script, /statusButton[^\n]*hidden\s*=/);
  assert.doesNotMatch(script, /leaveButton[^\n]*hidden\s*=/);

  assert.match(css, /\.settings-overlay/);
  assert.match(css, /\.settings-card/);
  assert.match(css, /body\.settings-open/);
});
