import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {classifyActionGesture} from "../public/src/free-roam-action-gestures.js";

test("a deliberate two-finger downward swipe launches the mega-bomb command", () => {
  assert.equal(classifyActionGesture({pointers: 2, duration: 300, dx: 2, dy: 90, movement: 90}), "mega-bomb");
  assert.equal(classifyActionGesture({pointers: 2, duration: 300, dx: 2, dy: -90, movement: 90}), "pump");
  assert.equal(classifyActionGesture({pointers: 2, duration: 300, dx: 90, dy: 2, movement: 90}), "weapon");
});

test("the live iPhone gesture sends the existing server-authoritative megaBomb pulse", async () => {
  const [client, html, core, activities, shopEntry] = await Promise.all([
    readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8"),
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-core-v6.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-activities.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-shop.js", import.meta.url), "utf8"),
  ]);

  assert.match(client, /megaBomb: false/);
  assert.match(client, /command === "mega-bomb"\) actionPulse\("megaBomb"\)/);
  assert.match(client, /localInput\.megaBomb = false/);
  assert.match(client, /free-roam-action-gestures\.js\?v=2/);
  assert.match(client, /free-roam-shop\.js\?v=4/);
  assert.match(client, /free-roam-core-v6\.js\?v=47/);
  assert.match(core, /free-roam-activities\.js\?v=44/);
  assert.match(core, /free-roam-shop\.js\?v=4/);
  assert.match(activities, /free-roam-shop\.js\?v=4/);
  assert.match(shopEntry, /free-roam-shop-v8\.js/);
  assert.match(html, /взмах двумя вниз — запуск мега-бомбы/);
  assert.match(html, /вниз — мега-бомба/);
  assert.match(html, /free-roam-v4\.js\?v=58/);
});
