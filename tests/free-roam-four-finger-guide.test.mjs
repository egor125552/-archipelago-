import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {classifyActionGesture} from "../public/src/free-roam-action-gestures.js";
import {turnBoatToSonar, updateSonarGuide} from "../public/src/free-roam-sonar-guide.js";

test("two-finger downward swipes no longer disable gestures", () => {
  assert.equal(classifyActionGesture({pointers: 2, duration: 300, dx: 4, dy: 90, movement: 90}), null);
  assert.equal(classifyActionGesture({pointers: 2, duration: 300, dx: 90, dy: 4, movement: 90}), "weapon");
  assert.equal(classifyActionGesture({pointers: 2, duration: 300, dx: 4, dy: -90, movement: 90}), "pump");
});

test("a stationary four-finger press requests one sonar turn", () => {
  assert.equal(classifyActionGesture({pointers: 4, duration: 160, dx: 2, dy: 1, movement: 3}), "guide");
  assert.equal(classifyActionGesture({pointers: 5, duration: 160, dx: 2, dy: 1, movement: 3}), null);
});

test("sonar guidance snaps the boat heading once and never stays enabled", () => {
  const events = [];
  const world = {
    players: [{mode: "boat", activeBoat: 0}],
    boats: [{x: 0, y: 0, heading: 217, rudder: 0.7, sonarGuideSteer: 0.2, sonarGuideTargetId: "old"}],
    freeScenario: {
      targets: [{id: "target", label: "ящик", x: 10, y: 0}],
      guideEnabled: [true],
    },
    freeActivities: {
      inputs: [{guide: true}],
      previousInputs: [{guide: false}],
    },
  };
  updateSonarGuide(world, (...args) => events.push(args));
  assert.equal(Math.round(world.boats[0].heading), 90);
  assert.equal(world.boats[0].rudder, 0);
  assert.equal(world.boats[0].sonarGuideSteer, 0);
  assert.equal(world.boats[0].sonarGuideTargetId, null);
  assert.equal(world.freeScenario.guideEnabled[0], false);
  assert.equal(events.length, 1);
  assert.equal(events[0][1], "sonar-guide-snap");
});

test("the instant turn refuses to act away from the helm", () => {
  const events = [];
  const world = {
    players: [{mode: "foot", activeBoat: null}],
    boats: [{x: 0, y: 0, heading: 10}],
    freeScenario: {targets: [{id: "target", label: "ящик", x: 10, y: 0}], guideEnabled: [false]},
  };
  assert.equal(turnBoatToSonar(world, 0, (...args) => events.push(args)), false);
  assert.equal(world.boats[0].heading, 10);
  assert.equal(events[0][1], "sonar-guide-unavailable");
});

test("four-finger chords block the three-finger automatic arming path", async () => {
  const source = await readFile(new URL("../public/src/free-roam-automatic-hold-v36.js", import.meta.url), "utf8");
  assert.match(source, /ARM_DELAY_MS/);
  assert.match(source, /blockedByExtraFinger = true/);
  assert.match(source, /activeTouches\.size > 3/);
  assert.match(source, /stopFiring\(\)/);
});
