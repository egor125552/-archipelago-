import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {retireClaimedKnifeCrates} from "../public/src/free-roam-unique-weapons.js";

const scenarioSource = await readFile(new URL("../public/src/free-roam-scenario.js", import.meta.url), "utf8");
const coreSource = await readFile(new URL("../public/src/free-roam-core-v6.js", import.meta.url), "utf8");
const startupSource = await readFile(new URL("../public/src/free-roam-startup-v1.js", import.meta.url), "utf8");
const savedWorldSource = await readFile(new URL("../public/src/free-roam-saved-world-v1.js", import.meta.url), "utf8");
const freeRoamHtml = await readFile(new URL("../public/free-roam.html", import.meta.url), "utf8");

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

test("knife sonar is offered before pursuit, not during it", () => {
  assert.match(coreSource, /free-roam-scenario\.js\?v=44/);
  assert.doesNotMatch(coreSource, /free-roam-scenario-v2/);
  assert.match(scenarioSource, /ARM_TARGET_MODES = Object\.freeze\(\["automatic", "knife"\]\)/);
  assert.match(scenarioSource, /До начала погони можно забрать нож/);
  assert.doesNotMatch(scenarioSource, /OPTIONAL_PURSUIT_KINDS/);
  assert.doesNotMatch(scenarioSource, /дополнительн(?:ая|ые) цел/iu);
});

test("arrival guidance runs once after the final sonar target is selected", () => {
  assert.equal(occurrences(scenarioSource, "updateCargoArrivalGuidance(world, emit);"), 1);
  const sonarIndex = scenarioSource.lastIndexOf("handleSonar(world, dt);");
  const arrivalIndex = scenarioSource.lastIndexOf("updateCargoArrivalGuidance(world, emit);");
  assert.ok(sonarIndex >= 0 && arrivalIndex > sonarIndex);
});

test("claimed knife crates are consumed and cannot announce a respawn", () => {
  const world = {
    players: [{combat: {weapons: {knife: true}}}, {combat: {weapons: {knife: false}}}],
    freeActivities: {
      crates: [{kind: "knife", state: "delivered", carriedBy: null, stowedBoat: null, respawnAt: 12}],
    },
  };
  assert.equal(retireClaimedKnifeCrates(world), true);
  assert.equal(world.freeActivities.crates[0].state, "consumed");
  assert.equal(world.freeActivities.crates[0].respawnAt, 0);
});

test("unclaimed knife remains available", () => {
  const world = {
    players: [{combat: {weapons: {knife: false}}}],
    freeActivities: {crates: [{kind: "knife", state: "world", respawnAt: 0}]},
  };
  assert.equal(retireClaimedKnifeCrates(world), false);
  assert.equal(world.freeActivities.crates[0].state, "world");
});

test("gesture mode guards accidental exits without persisting world identity in the browser", () => {
  assert.doesNotMatch(startupSource, /echo-free-roam-active-session-v1/);
  assert.doesNotMatch(startupSource, /sessionStorage/);
  assert.match(startupSource, /active: \(\) => null/);
  assert.match(startupSource, /autoResumeEnabled: \(\) => false/);
  assert.match(savedWorldSource, /fetch\(`\/api\/saved-world/);
  assert.match(savedWorldSource, /url\.searchParams\.set\("room", savedWorld\.room\)/);
  assert.match(freeRoamHtml, /free-roam-startup-v1\.js\?v=7/);
  assert.match(startupSource, /gestureMode && directPointerClick/);
  assert.match(startupSource, /leaveConfirmUntil = now \+ 2800/);
  assert.match(startupSource, /touchmove/);
  assert.match(startupSource, /passive: false/);
  assert.doesNotMatch(startupSource, /retryingPreferredRoom|retry-preferred-room|reconnectRetry/);
});

test("page reload stays in the menu unless server-discovered auto return is explicitly enabled", () => {
  assert.match(savedWorldSource, /echo-free-roam-interface-settings-v1/);
  assert.match(savedWorldSource, /settings\?\.autoResume === true/);
  assert.match(savedWorldSource, /if \(ready && savedWorld && autoResumeEnabled\(\)\)/);
  assert.match(savedWorldSource, /No browser-side room or role marker is used/);
  assert.match(freeRoamHtml, /id="settingsAutoResumeButton"/);
  assert.match(freeRoamHtml, /После обновления: остаться в меню/);
});
