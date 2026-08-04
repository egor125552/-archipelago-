import test from "node:test";
import assert from "node:assert/strict";

import {
  IMPACT_SOUND_SECONDS,
  attachExplosionSpatialV31,
} from "../src/free-roam-mega-bomb-v31.js";

function worldWithExplosion() {
  return {
    time: 10,
    players: [
      {x: 100, y: 100, heading: 0, mode: "foot"},
      {x: 220, y: 100, heading: 180, mode: "foot"},
    ],
    boats: [],
    freeActivities: {presence: [true, true]},
    events: [{
      type: "mega-bomb-explosion",
      projectileId: "mega-bomb-test",
      sourcePlayer: 0,
      x: 160,
      y: 100,
      z: 0,
      surface: "water",
      reason: "water-impact",
      targets: [0, 1],
      at: 10,
    }],
  };
}

test("one explosion carries its initial spatial state without follow-up event spam", () => {
  const world = worldWithExplosion();
  assert.equal(attachExplosionSpatialV31(world), 1);
  assert.equal(world.events.length, 1);
  const event = world.events[0];
  assert.equal(event.type, "mega-bomb-explosion");
  assert.equal(event.duration, IMPACT_SOUND_SECONDS);
  assert.equal(event.impactSpatialV31, true);
  assert.equal(event.spatial.length, 2);
  assert.ok(event.spatial.every(value => Number.isFinite(value.pan)));
  assert.ok(event.spatial.every(value => Number.isFinite(value.distance)));
  assert.equal(world.events.some(value => value.type === "mega-bomb-explosion-spatial"), false);
});

test("revisiting retained events never emits or duplicates acoustic updates", () => {
  const world = worldWithExplosion();
  for (let step = 0; step < 140; step += 1) {
    attachExplosionSpatialV31(world);
    world.time += 0.08;
  }
  assert.equal(world.events.length, 1);
  assert.equal(world.events.filter(event => event.type === "mega-bomb-explosion").length, 1);
  assert.equal(world.events.filter(event => event.type === "mega-bomb-explosion-spatial").length, 0);
});
