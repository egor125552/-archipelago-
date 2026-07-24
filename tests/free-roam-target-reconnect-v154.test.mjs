import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {createTargetMenu} from "../public/src/free-roam-target-menu.js";
import {startThreatEncounter} from "../public/src/free-roam-threat-director.js";
import {
  contextualSonarAction,
  targetMenuGestureAction,
} from "../public/src/free-roam-target-gesture-policy.js";
import {
  reconnectDelay,
  reconnectLobbyMatches,
  shouldExpireSilentConnection,
} from "../public/src/free-roam-reconnect-policy.js";

test("combat target gestures tolerate iPhone two-finger vertical swipes", () => {
  assert.equal(targetMenuGestureAction({pointers: 1, movement: 60, dx: 4, dy: -60}), "previous");
  assert.equal(targetMenuGestureAction({pointers: 2, movement: 65, dx: 8, dy: 64}), "next");
  assert.equal(targetMenuGestureAction({pointers: 2, movement: 4, dx: 1, dy: 3}), "tap-command");
  assert.equal(targetMenuGestureAction({pointers: 3, movement: 2, dx: 0, dy: 2}), "cancel");
  assert.equal(targetMenuGestureAction({pointers: 2, movement: 70, dx: 70, dy: 5}), "report");
  assert.equal(contextualSonarAction({combatActive: true, targetMenuOpen: false}), "open-targets");
  assert.equal(contextualSonarAction({combatActive: true, targetMenuOpen: true}), "report");
  assert.equal(contextualSonarAction({combatActive: false, targetMenuOpen: false}), "sonar");
});

test("the combat menu can repeat its current target without closing", () => {
  const world = createFreeWorld();
  world.freeScenario.phase = "victory";
  startThreatEncounter(world, 3, "target-report");
  const spoken = [];
  const menu = createTargetMenu({
    getWorld: () => world,
    getPlayerIndex: () => 0,
    getTargetId: () => null,
    setTargetId: () => {},
    releaseMovement: () => {},
    sendInput: () => {},
    announce: text => spoken.push(text),
    render: () => {},
  });
  menu.open();
  assert.equal(menu.isOpen(), true);
  assert.equal(menu.reportCurrent(), true);
  assert.equal(menu.isOpen(), true);
  assert.match(spoken.at(-1), /Боевая цель/);
});

test("reconnect policy accepts an automatically recreated exact room", () => {
  assert.equal(reconnectLobbyMatches({
    targetRoom: "FREE-LOST",
    requestedRole: "captain",
    message: {room: "FREE-LOST", role: "captain", recreatedRoom: true},
  }), true);
  assert.equal(reconnectLobbyMatches({
    targetRoom: "FREE-LOST",
    requestedRole: "captain",
    message: {room: "FREE-OTHER", role: "captain", recreatedRoom: true},
  }), false);
  assert.equal(reconnectDelay(0), 400);
  assert.equal(reconnectDelay(99), 10_000);
  assert.equal(shouldExpireSilentConnection({now: 15_000, lastServerMessageAt: 500, gameVisible: true}), true);
  assert.equal(shouldExpireSilentConnection({now: 15_000, lastServerMessageAt: 500, gameVisible: false}), false);
});

test("live gesture and reconnect code routes combat sonar and force-expires stalled sockets", async () => {
  const [client, html, startup] = await Promise.all([
    readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8"),
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-startup-v1.js", import.meta.url), "utf8"),
  ]);
  assert.match(client, /command === "sonar"\) useSonarOrCombatTargets\(\)/);
  assert.match(client, /combatActive: combatTargetingRequired\(\)/);
  assert.match(client, /action === "open-targets"\) targetMenu\.open\(\)/);
  assert.match(client, /targetMenu\.reportCurrent\(\)/);
  assert.match(client, /socket = null;[\s\S]*connection\.close\(4104, reason\)/);
  assert.match(client, /state-load-timeout/);
  assert.match(startup, /message\.recreatedRoom === true/);
  assert.match(html, /free-roam-startup-v1\.js\?v=7/);
  assert.match(html, /free-roam-v4\.js\?v=52/);
});
