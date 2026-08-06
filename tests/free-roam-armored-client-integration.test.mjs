import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {predictLocalWorld} from "../public/src/free-roam-client-prediction.js";

function predictedWorld(boatType) {
  const boat = {
    id: 0,
    boatType,
    driver: 0,
    x: 210,
    y: 210,
    heading: 0,
    speed: 0,
    throttle: 0,
    collisionRadius: boatType === "dual-turret-patrol" ? 7.5 : 6,
    engineStalled: false,
    emergencyActive: false,
    sunk: false,
  };
  return {
    boats: [boat],
    players: [{mode: "boat", activeBoat: 0, x: boat.x, y: boat.y, heading: 0, combat: {}}],
  };
}

test("ordinary and armored boats use one client prediction law", () => {
  const ordinary = predictedWorld("standard");
  const armored = predictedWorld("dual-turret-patrol");
  const input = {up: true, right: true};
  for (let index = 0; index < 20; index += 1) {
    predictLocalWorld(ordinary, 0, input, 0.05);
    predictLocalWorld(armored, 0, input, 0.05);
  }
  assert.equal(armored.boats[0].speed, ordinary.boats[0].speed);
  assert.equal(armored.boats[0].throttle, ordinary.boats[0].throttle);
  assert.equal(armored.boats[0].heading, ordinary.boats[0].heading);
  assert.equal(armored.boats[0].x, ordinary.boats[0].x);
  assert.equal(armored.boats[0].y, ordinary.boats[0].y);
});

test("armored engine is selected by the common audio view without mutating world state", async () => {
  const [prediction, audio, audioV2, client, headers] = await Promise.all([
    readFile(new URL("../public/src/free-roam-client-prediction.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio-v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-client.js", import.meta.url), "utf8"),
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(prediction, /DUAL_TURRET_(MAX_SPEED|REVERSE_SPEED|TURN_FACTOR|ACCELERATION_FACTOR)/);
  assert.doesNotMatch(prediction, /isDualTurretBoat/);
  assert.match(audio, /activeBoat\.audioProfile === "dual-turret"/);
  assert.match(audio, /engineStalled: Boolean\([^\n]*customEngine\)/);
  assert.match(audio, /updateDualTurretEngine\(this, world, playerIndex\)/);
  assert.doesNotMatch(audio, /customBoat\.engineStalled\s*=/);
  assert.match(audioV2, /handleDualTurretAudioEvent/);
  assert.doesNotMatch(client, /preloadDualTurretAudio|updateDualTurretEngine|^\s*customBoat\.engineStalled\s*=/m);
  assert.match(headers, /\/src\/\*/);
  assert.match(headers, /Cache-Control: no-cache, must-revalidate/);
});
