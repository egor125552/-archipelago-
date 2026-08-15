import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld} from "../public/src/free-roam-core-v8.js";
import {ensureCombat} from "../public/src/free-roam-combat-v2.js?v=6";
import {activeEliteBoatBoss} from "../public/src/free-roam-elite-boat.js?v=2";
import {activeHeavyPursuer, damageHeavyPursuer, startHeavyPursuer} from "../public/src/free-roam-heavy-pursuer.js?v=4";
import {startThreatEncounter} from "../public/src/free-roam-threat-director.js?v=4";
import {recoverOrphanedHeavyPhase} from "../src/free-roam-threat-recovery.js";

function orphanedHeavyWorld() {
  const world = createFreeWorld();
  ensureCombat(world, 0);
  world.freeActivities.presence = [true, false];
  world.players[0].combat.alive = true;

  const threat = startThreatEncounter(world, 5, "orphaned-heavy-regression");
  const heavy = startHeavyPursuer(world, threat.encounterId, {x: 92, y: 92}, 0);
  heavy.hull = 12;
  threat.heavyStarted = true;
  threat.heavyStartsAt = world.time;
  threat.eliteBossStarted = false;
  threat.assignments[heavy.id] = 0;

  // Deliberately reproduce the integration hole: the heavy boat is destroyed
  // without onEnemyBoatDestroyed. The world must still heal itself.
  damageHeavyPursuer(world, "hull", 12, 0, {}, {weapon: "stress-pistol"});
  return {world, threat, heavy};
}

test("server recovery starts the elite boss when heavy destruction callback is missing", () => {
  const {world, threat} = orphanedHeavyWorld();

  assert.equal(activeHeavyPursuer(world), null);
  assert.equal(threat.eliteBossStarted, false, "the deliberately missing callback must reproduce the orphaned phase first");
  assert.equal(activeEliteBoatBoss(world), null);

  assert.equal(recoverOrphanedHeavyPhase(world), true);
  assert.equal(threat.eliteBossStarted, true);
  assert.ok(activeEliteBoatBoss(world), "authoritative recovery must create the elite boss");
  assert.ok(world.events.some(event => event.type === "contract-threat-phase" && event.phase === 3));
  assert.ok(world.events.some(event => event.type === "contract-threat-phase-recovered" && event.phase === 3));
});

test("server recovery also heals a stopped director while the level-five contract is still combat-active", () => {
  const {world, threat} = orphanedHeavyWorld();
  threat.active = false;
  world.freeContracts.encounterActive = true;
  world.freeContracts.encounterLevel = 5;

  assert.equal(recoverOrphanedHeavyPhase(world), true);
  assert.equal(threat.active, true);
  assert.equal(threat.eliteBossStarted, true);
  assert.ok(activeEliteBoatBoss(world));
});
