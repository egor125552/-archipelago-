import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {impactSpatialStateV1} from "../public/src/free-roam-mega-bomb-impact-spatial-v1.js";
import {clearLegacyImpactAcousticsV31} from "../src/free-roam-mega-bomb-v31.js";

function worldAt(x, y, heading = 0) {
  return {
    players: [{mode: "boat", activeBoat: 0}],
    boats: [{id: 0, x, y, heading}],
    freeActivities: {presence: [true]},
  };
}

test("a fixed explosion tail follows authoritative listener movement locally", () => {
  const impact = {x: 210, y: 220, z: 0, surface: "water"};
  const world = worldAt(170, 220, 0);
  const first = impactSpatialStateV1(world, 0, impact);
  assert.ok(first.pan > 0.9);
  assert.equal(first.distance, 40);

  world.boats[0].x = 205;
  world.boats[0].heading = 90;
  const moved = impactSpatialStateV1(world, 0, impact);
  assert.equal(moved.distance, 5);
  assert.ok(moved.gain > first.gain);
  assert.ok(Math.abs(moved.pan) < 0.05);
  assert.deepEqual({x: impact.x, y: impact.y, z: impact.z}, {x: 210, y: 220, z: 0});
});

test("each network explosion remains one terminal server event", async () => {
  const serverSource = await readFile(new URL("../src/free-roam-mega-bomb-v31.js", import.meta.url), "utf8");
  assert.doesNotMatch(serverSource, /mega-bomb-explosion-spatial/);
  assert.doesNotMatch(serverSource, /IMPACT_SOUND_SECONDS|UPDATE_INTERVAL/);

  const world = {freeMegaBombAcoustics: {impacts: [{projectileId: "old"}], seen: ["old"]}};
  assert.equal(clearLegacyImpactAcousticsV31(world), true);
  assert.equal(world.freeMegaBombAcoustics, undefined);
});

test("the live client installs local impact tracking with a Safari cache buster", async () => {
  const alias = await readFile(new URL("../public/src/free-roam-mega-bomb-client.js", import.meta.url), "utf8");
  assert.match(alias, /free-roam-mega-bomb-client-v25\.js\?v=2/);
  assert.match(alias, /free-roam-mega-bomb-impact-spatial-v1\.js\?v=1/);
});
