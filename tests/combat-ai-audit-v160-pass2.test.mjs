import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v6.js";
import {startThreatEncounter} from "../public/src/free-roam-threat-director.js";
import {activeHostileActors} from "../public/src/free-roam-hostile-actors.js";
import {updatePursuerSquad} from "../public/src/free-roam-pursuer-squad.js";
import {startHeavyPursuer, updateHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js";
import {finishThreatIntelligence, prepareThreatIntelligence} from "../public/src/free-roam-threat-intelligence.js";

function soloWorld() {
  const world = createFreeWorld();
  world.freeActivities.presence = [true, false];
  world.players[0].combat.alive = true;
  world.events = [];
  return world;
}

test("threat four actor cap leaves the second rammer and gunboat without physical crews", () => {
  const world = soloWorld();
  startThreatEncounter(world, 4, "audit-pass2-level4");
  const actors = activeHostileActors(world);
  assert.equal(actors.length, 6);
  const crewedBoats = new Set(actors.map(actor => actor.boatId));
  assert.ok(crewedBoats.has("threat-boat-1"));
  assert.equal(crewedBoats.has("threat-boat-2"), false);
  assert.equal(crewedBoats.has("threat-boat-3"), false);
});

test("base pursuer boats keep identical fixed five-shot bursts despite irregular-fire layer", () => {
  const world = soloWorld();
  startThreatEncounter(world, 3, "audit-pass2-bursts");
  const shotTimes = [];
  let seen = world.events.length;
  for (let index = 0; index < 320; index += 1) {
    const frame = prepareThreatIntelligence(world);
    updatePursuerSquad(world, 0.05, {});
    finishThreatIntelligence(world, frame, 0.05);
    for (const event of world.events.slice(seen)) {
      if (event.type === "enemy-gun-shot" && String(event.sourcePursuerId || "").startsWith("pursuer-")) {
        shotTimes.push(Number(world.time.toFixed(2)));
      }
    }
    seen = world.events.length;
    world.time += 0.05;
  }
  assert.ok(shotTimes.length >= 10);
  const groups = [];
  let current = [];
  for (const time of shotTimes) {
    if (current.length && time - current.at(-1) > 0.5) { groups.push(current); current = []; }
    current.push(time);
  }
  if (current.length) groups.push(current);
  assert.ok(groups.length >= 2);
  assert.deepEqual(groups.slice(0, 2).map(group => group.length), [5, 5]);
});

test("the advertised heavy-turret dead sector does not exist", () => {
  const world = soloWorld();
  const player = world.players[0];
  Object.assign(player, {mode: "foot", activeBoat: null, x: 210, y: 280});
  startHeavyPursuer(world, 1, {x: 92, y: 92}, 0);
  const heavy = world.freeHeavyPursuer.boat;
  Object.assign(heavy, {
    x: 210,
    y: 180,
    heading: 0,
    turretHeading: 0,
    speed: 0,
    engineHealth: 0,
    engineDisabled: true,
    fireCooldown: 0,
    aimRemaining: 0,
    burstRemaining: 0,
  });
  let shots = 0;
  let maximumTurn = 0;
  let seen = world.events.length;
  for (let index = 0; index < 320; index += 1) {
    updateHeavyPursuer(world, 0.05, {});
    maximumTurn = Math.max(maximumTurn, Math.abs(Number(heavy.turretHeading) || 0));
    for (const event of world.events.slice(seen)) if (event.type === "heavy-gun-shot") shots += 1;
    seen = world.events.length;
    world.time += 0.05;
  }
  assert.ok(maximumTurn > 150);
  assert.ok(shots > 0);
});
