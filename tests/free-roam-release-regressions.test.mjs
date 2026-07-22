import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const scenarioSource = await readFile(new URL("../public/src/free-roam-scenario-v2.js", import.meta.url), "utf8");
const coreSource = await readFile(new URL("../public/src/free-roam-core-v6.js", import.meta.url), "utf8");
const startupSource = await readFile(new URL("../public/src/free-roam-startup-v1.js", import.meta.url), "utf8");

test("knife sonar is offered before pursuit, not during it", () => {
  assert.match(coreSource, /free-roam-scenario-v2\.js\?v=1/);
  assert.match(scenarioSource, /ARM_MODES = Object\.freeze\(\["automatic", "knife"\]\)/);
  assert.match(scenarioSource, /До начала погони можно забрать нож/);
  assert.match(scenarioSource, /resetLegacyPursuitChoices/);
  assert.match(scenarioSource, /scenario\.phase !== "pursuit"/);
  assert.doesNotMatch(scenarioSource, /OPTIONAL_PURSUIT_KINDS/);
});

test("sonar speech no longer calls targets primary or optional", () => {
  assert.match(scenarioSource, /Сонар: цель — \$\{target\.label\}/);
  assert.match(scenarioSource, /replace\("Сонар: основная цель — ", "Сонар: цель — "\)/);
  assert.match(scenarioSource, /replace\("Сонар: дополнительная цель — ", "Сонар: цель — "\)/);
});

test("gesture mode guards accidental exits and page reloads", () => {
  assert.match(startupSource, /echo-free-roam-active-session-v1/);
  assert.match(startupSource, /sessionStorage\.setItem/);
  assert.match(startupSource, /url\.searchParams\.set\("room", resumeSession\.room\)/);
  assert.match(startupSource, /gestureMode && directPointerClick/);
  assert.match(startupSource, /leaveConfirmUntil = now \+ 2800/);
  assert.match(startupSource, /touchmove/);
  assert.match(startupSource, /passive: false/);
  assert.match(startupSource, /gestureReportButton/);
});
