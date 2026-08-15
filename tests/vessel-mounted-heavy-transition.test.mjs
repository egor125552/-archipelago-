import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v8.js";
import {ensureCombat} from "../public/src/free-roam-combat-v2.js?v=6";
import {startHeavyPursuer, activeHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js?v=4";
import {activeEliteBoatBoss} from "../public/src/free-roam-elite-boat.js?v=2";
import {ensureHostileActors} from "../public/src/free-roam-hostile-actors.js?v=3";
import {startThreatEncounter} from "../public/src/free-roam-threat-director.js?v=4";
import {VESSEL_MOUNTED_WEAPON_SYSTEMS} from "../public/src/vessel/systems/vessel-mounted-weapon-system.js?v=3";

function mountedContext(world, sourceBoat) {
  const definition = {
    id: "mounted-heavy-regression-vessel",
    modules: [{
      id: "regression-pistol",
      type: "mounted-weapon",
      mounts: [],
      config: {
        runtimeSystem: "station-hitscan-v1",
        stationResourceId: "regression-pistol-control",
        damage: 20,
        range: 620,
        interval: 0.04,
        weaponId: "stress-pistol",
        label: "сверхскоростная пистолетная установка",
      },
    }],
    decks: [{
      id: "regression-deck",
      objects: [{
        id: "regression-pistol-station",
        kind: "station",
        resourceId: "regression-pistol-control",
        controlsModule: "regression-pistol",
      }],
    }],
    mounts: [],
  };
  const instance = {
    modules: {
      "regression-pistol": {
        ammo: 10,
        cooldown: 0,
        enabled: true,
        health: 100,
      },
    },
    occupants: {
      0: {deckId: "regression-deck", x: 0, y: 0, heading: 0},
    },
    interior: {
      claims: {"regression-pistol-control": 0},
      walkableControl: {inputs: {"0": {attack: true}}},
    },
  };
  return {
    world,
    nativeVessels: [{boat: sourceBoat, definition, instance}],
    dt: 0.04,
  };
}

test("mounted stress pistol destroying the heavy pursuer immediately starts the elite phase", () => {
  const world = createFreeWorld();
  ensureCombat(world, 0);
  world.freeActivities.presence = [true, false];

  const threat = startThreatEncounter(world, 5, "mounted-heavy-regression");
  const sourceBoat = {
    id: "regression-source-boat",
    boatType: "stress-test-vessel",
    audioProfile: "stress-test-vessel",
    x: 210,
    y: 180,
    heading: 0,
    sunk: false,
    reserved: false,
  };
  world.boats.push(sourceBoat);
  world.players[0].mode = "boat";
  world.players[0].activeBoat = sourceBoat.id;
  world.players[0].x = sourceBoat.x;
  world.players[0].y = sourceBoat.y;
  world.players[0].combat.alive = true;
  world.players[0].combat.lockedTargetId = "heavy-pursuer";

  const heavy = startHeavyPursuer(world, threat.encounterId, {x: 92, y: 92}, 0);
  heavy.x = 210;
  heavy.y = 215;
  heavy.hull = 12;
  threat.heavyStarted = true;
  threat.heavyStartsAt = world.time;
  threat.eliteBossStarted = false;
  threat.assignments[heavy.id] = 0;

  const hostileState = ensureHostileActors(world);
  hostileState.active = true;
  hostileState.actors.push({
    id: "heavy-regression-crew",
    boatId: heavy.id,
    state: "aboard",
    active: true,
    destroyed: false,
    x: heavy.x,
    y: heavy.y,
    seatOffset: 0,
  });

  const mountedSystem = VESSEL_MOUNTED_WEAPON_SYSTEMS.find(system => system.id === "vessel-station-hitscan-weapons-v2");
  assert.ok(mountedSystem);
  mountedSystem.run(mountedContext(world, sourceBoat));

  assert.equal(activeHeavyPursuer(world), null, "the mounted shot must really destroy the heavy pursuer");
  assert.equal(threat.eliteBossStarted, true, "heavy destruction must advance the threat director in the same step");
  assert.ok(activeEliteBoatBoss(world), "the elite boat boss must exist immediately after heavy destruction");
  assert.equal(hostileState.actors.find(actor => actor.id === "heavy-regression-crew")?.state, "swim", "the destroyed boat crew must be released into the water");

  const phase = world.events.find(event => event.type === "contract-threat-phase" && event.phase === 3);
  assert.ok(phase, "the transition to the elite phase must be announced");
  const shot = world.events.find(event => event.type === "vessel-mounted-shot" && event.weapon === "stress-pistol");
  assert.ok(shot);
  assert.equal(shot.targetKind, "heavyHull");
  assert.equal(shot.applied, true);
});
