import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {localImpactSpatialV1} from "../public/src/free-roam-mega-bomb-impact-follow-v1.js";

function worldAt(x, y, heading = 0) {
  return {
    players: [{mode: "boat", activeBoat: 0}],
    boats: [{id: 0, x, y, heading}],
    freeActivities: {presence: [true]},
  };
}

test("a fixed explosion tail follows listener movement without changing the server source", () => {
  const impact = {
    projectileId: "impact-1",
    x: 10,
    y: 0,
    z: 0,
    surface: "water",
    spatial: [{occluded: true}],
  };
  const world = worldAt(0, 0, 0);
  const first = localImpactSpatialV1(world, 0, impact);
  assert.ok(first.pan > 0.99);
  assert.equal(first.distance, 10);
  assert.equal(first.occluded, true);

  world.boats[0].x = 9;
  world.boats[0].heading = 90;
  const moved = localImpactSpatialV1(world, 0, impact);
  assert.equal(moved.distance, 1);
  assert.ok(Math.abs(moved.pan) < 0.01);
  assert.ok(moved.gain > first.gain);
  assert.deepEqual({x: impact.x, y: impact.y, z: impact.z}, {x: 10, y: 0, z: 0});
});

test("the client follow-up is local presentation and never a network producer", async () => {
  const source = await readFile(new URL("../public/src/free-roam-mega-bomb-impact-follow-v1.js", import.meta.url), "utf8");
  assert.match(source, /localPresentationOnly: true/);
  assert.match(source, /const UPDATE_MS = 50/);
  assert.doesNotMatch(source, /WebSocket|\.send\(|free-input/);
});

test("the live alias loads both the existing client and the local follow-up with cache busters", async () => {
  const alias = await readFile(new URL("../public/src/free-roam-mega-bomb-client.js", import.meta.url), "utf8");
  assert.match(alias, /free-roam-mega-bomb-client-v25\.js\?v=2/);
  assert.match(alias, /free-roam-mega-bomb-impact-follow-v1\.js\?v=1/);
});
