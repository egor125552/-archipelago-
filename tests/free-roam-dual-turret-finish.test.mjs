import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {reconcileLocalPrediction} from "../public/src/free-roam-client-prediction.js";
import {
  applyDualTurretSpeech,
  attachPatrolExitBoatIds,
} from "../public/src/free-roam-dual-turret-speech.js";

test("authoritative sonar turn is not blended back toward the old heading", () => {
  const previousWorld = {
    players: [{mode: "boat", activeBoat: 2, x: 100, y: 100, heading: 0}],
    boats: [null, null, {id: 2, x: 100, y: 100, heading: 0, speed: 0, throttle: 0, collisionRadius: 7.5}],
  };
  const nextWorld = {
    players: [{mode: "boat", activeBoat: 2, x: 100, y: 100, heading: 90}],
    boats: [null, null, {id: 2, x: 100, y: 100, heading: 90, speed: 0, throttle: 0, collisionRadius: 7.5}],
  };

  const result = reconcileLocalPrediction(previousWorld, nextWorld, 0);
  assert.equal(result.boats[2].heading, 90);
  assert.equal(result.players[0].heading, 90);
});

test("armored patrol events speak about armor, hull and repair plates", () => {
  const boat = {
    id: 2,
    boatType: "dual-turret-patrol",
    crew: [0, null],
    hull: 248,
    hullMax: 300,
    armor: 121,
    armorMax: 200,
    repairPatches: 4,
  };
  const world = {
    players: [{mode: "boat", activeBoat: 2}],
    boats: [null, null, boat],
    events: [
      {type: "player-boat-damaged", text: "ordinary damage", targets: [0], boatId: 2},
      {type: "hull-repair-complete", text: "ordinary repair", targets: [0], boatId: 2},
    ],
  };

  applyDualTurretSpeech(world, 0);
  assert.match(world.events[0].text, /Бронекатер/);
  assert.match(world.events[0].text, /корпус 248 из 300/);
  assert.match(world.events[0].text, /броня 121 из 200/);
  assert.match(world.events[1].text, /Пластина закреплена/);
  assert.match(world.events[1].text, /Пластин осталось 4/);
});

test("generic driver exit keeps patrol context and receives patrol wording", () => {
  const boat = {
    id: 2,
    boatType: "dual-turret-patrol",
    crew: [null, null],
    hull: 300,
    hullMax: 300,
    armor: 200,
    armorMax: 200,
  };
  const world = {
    players: [{mode: "swim", activeBoat: null}],
    boats: [null, null, boat],
    events: [{type: "exit", text: "Ты спрыгнул в воду.", targets: [0], sourcePlayer: 0}],
  };

  attachPatrolExitBoatIds(world, 0, [2]);
  applyDualTurretSpeech(world, 0);
  assert.equal(world.events[0].boatId, 2);
  assert.equal(world.events[0].text, "Ты покинул бронекатер и спрыгнул в воду.");
});

test("prediction source contains no separate armored-boat physics", async () => {
  const source = await readFile(new URL("../public/src/free-roam-client-prediction.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DUAL_TURRET_MAX_SPEED/);
  assert.doesNotMatch(source, /DUAL_TURRET_TURN_FACTOR/);
  assert.doesNotMatch(source, /DUAL_TURRET_ACCELERATION_FACTOR/);
  assert.match(source, /reconciledHeading/);
});

test("Safari import map sends stale prediction code directly to the current shared prediction", async () => {
  const html = await readFile(new URL("../public/free-roam.html", import.meta.url), "utf8");
  assert.match(html, /free-roam-client-prediction\.js\?v=42[^\n]+free-roam-client-prediction\.js\?v=44/);
});
