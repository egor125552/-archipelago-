import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const combat = fs.readFileSync(new URL("../public/src/free-roam-combat-experience-v1.js", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8");

test("filtered narration is rejected before the high-level speech controller", () => {
  assert.match(combat, /globalThis\.__echoFreeRoamSpeechAllowed = speechAllowed;/);
  const announceStart = client.indexOf("function announce(");
  const socketStart = client.indexOf("function socketUrl(", announceStart);
  assert.ok(announceStart >= 0 && socketStart > announceStart);
  const announce = client.slice(announceStart, socketStart);
  const gate = announce.indexOf("speechGate(text)");
  const speak = announce.indexOf("speech.speak(text");
  assert.ok(gate >= 0, "announce must consult the narration filter");
  assert.ok(speak > gate, "filter must run before speech controller speak/cancel path");
  assert.match(announce, /\$\("message"\)\.textContent = text;/, "filtered narration must remain visible on screen");
});

test("combat filter cache-buster chain points at the updated policy module", () => {
  const v2 = fs.readFileSync(new URL("../public/src/free-roam-combat-experience-v2.js", import.meta.url), "utf8");
  const v3 = fs.readFileSync(new URL("../public/src/free-roam-combat-experience-v3.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../public/free-roam.html", import.meta.url), "utf8");
  assert.match(v2, /free-roam-combat-experience-v1\.js\?v=2/);
  assert.match(v3, /free-roam-combat-experience-v2\.js\?v=2/);
  assert.match(html, /free-roam-v4\.js\?v=67/);
  assert.match(html, /free-roam-combat-experience-v3\.js\?v=2/);
});
