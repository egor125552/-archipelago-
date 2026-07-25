import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("keyboard sonar uses the same immediate local-feedback path as buttons and gestures", async () => {
  const source = await readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8");
  assert.match(source, /event\.code === "KeyQ"[\s\S]{0,140}useSonarOrCombatTargets\(\)/);
  assert.match(source, /function useSonarOrCombatTargets\([\s\S]{0,520}playLocalCommandCue\?\.\("sonar"\)[\s\S]{0,120}actionPulse\("sonar"\)/);
});
