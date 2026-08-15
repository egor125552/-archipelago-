import test from "node:test";
import assert from "node:assert/strict";

import {
  DEVELOPER_LOG_FORMAT_V3,
  TRACK_FIELDS,
  applyTrackDelta,
  decodeTrackSamples,
  encodeTrackDelta,
  makeTrackSample,
  restoreAggregate,
  stripEventEnvelope,
  summarizeAggregate,
} from "../public/src/free-roam-developer-log-format-v3.js";

test("v3 track deltas round-trip movement and structural state", () => {
  const first = {x: 280.392, y: 76, heading: 91, speed: 0, mode: "boat", hull: 26.2, water: 1.4};
  const second = {...first, x: 285.2, y: 77.9, speed: -3.2, hull: 25};
  const third = {...second, x: 333, y: 78, hull: 0.1};

  const samples = [
    makeTrackSample(0, null, first),
    makeTrackSample(250, first, second),
    makeTrackSample(500, second, third),
  ];
  const decoded = decodeTrackSamples(samples);

  assert.deepEqual(decoded.map(({timeMs, ...state}) => [timeMs, state]), [
    [0, Object.fromEntries(TRACK_FIELDS.filter(key => first[key] !== undefined).map(key => [key, first[key]]))],
    [250, Object.fromEntries(TRACK_FIELDS.filter(key => second[key] !== undefined).map(key => [key, second[key]]))],
    [500, Object.fromEntries(TRACK_FIELDS.filter(key => third[key] !== undefined).map(key => [key, third[key]]))],
  ]);
});

test("v3 event envelope removes only duplicated transport fields", () => {
  const compact = stripEventEnvelope({
    type: "mega-bomb-explosion",
    at: 10.25,
    operationEvent: true,
    text: "",
    projectileId: "bomb-1",
    x: 10,
    y: 20,
    hitCount: 1,
  });
  assert.deepEqual(compact, {projectileId: "bomb-1", x: 10, y: 20, hitCount: 1});
});

test("v3 aggregate rows retain counts, timing, damage and endpoints", () => {
  const source = {
    type: "elite-turret-shot",
    firstAt: 11,
    lastAt: 11.4,
    count: 4,
    damage: 0,
    firstProjectileId: "a",
    lastProjectileId: "d",
    turretId: "port",
    targetPlayer: 0,
    firstX: 100,
    firstY: 120,
    lastX: 105,
    lastY: 118,
    hits: 0,
    misses: 0,
  };
  assert.deepEqual(restoreAggregate(summarizeAggregate(source)), {
    type: "elite-turret-shot",
    firstAt: 11,
    lastAt: 11.4,
    count: 4,
    damage: 0,
    firstProjectileId: "a",
    lastProjectileId: "d",
    turretId: "port",
    weapon: null,
    reason: null,
    sourcePlayer: null,
    targetPlayer: 0,
    targetId: null,
    firstX: 100,
    firstY: 120,
    lastX: 105,
    lastY: 118,
    hits: 0,
    misses: 0,
  });
});

test("format identifier is explicit", () => {
  assert.equal(DEVELOPER_LOG_FORMAT_V3, "archipelago-developer-log-v3");
  assert.ok(encodeTrackDelta(null, {x: 1, y: 2}).length > 0);
  assert.deepEqual(applyTrackDelta({}, encodeTrackDelta(null, {x: 1, y: 2})), {x: 1, y: 2});
});

test("live loader chain cache-busts developer log v3", async () => {
  const fs = await import("node:fs");
  const wrapper = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v1.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../public/free-roam.html", import.meta.url), "utf8");
  const logger = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v3.js", import.meta.url), "utf8");
  assert.match(wrapper, /free-roam-developer-log-v3\.js\?v=1/);
  assert.match(html, /free-roam-developer-log-v1\.js\?v=3/);
  assert.match(logger, /CompressionStream\("gzip"\)/);
  assert.match(logger, /CHECKPOINT_INTERVAL_MS = 10000/);
  assert.match(logger, /BOMB_TRACE_INTERVAL_MS = 500/);
  assert.match(logger, /respawn/);
});
