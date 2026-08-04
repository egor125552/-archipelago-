import test from "node:test";
import assert from "node:assert/strict";

import {
  resetHeavyThreatState,
  startThreatEncounter,
} from "../public/src/free-roam-threat-director.js";

function worldWithOldHeavy() {
  return {
    time: 7335.4,
    events: [],
    players: [{x: 210, y: 180, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeThreatDirector: {
      active: true,
      level: 5,
      encounterId: 12,
      contractId: "old-contract",
      assignments: {"heavy-pursuer": 0, "opening-boat": 0},
      actorAssignments: {"old-heavy-crew": 0, "opening-crew": 0},
      graceUntil: [0],
      heavyStarted: true,
      heavyStartsAt: 0,
    },
    freeHeavyPursuer: {
      active: true,
      encounterId: 12,
      v176ContractId: "old-contract",
      nextProjectileId: 18,
      boat: {
        id: "heavy-pursuer",
        active: true,
        destroyed: false,
        speed: 4,
        x: 205,
        y: 119,
        hull: 218,
        engineHealth: 0,
        turretHealth: 0,
        v176ContractId: "old-contract",
      },
      projectiles: [{id: "old-heavy-shot"}],
    },
    freeHostileActors: {
      active: true,
      actors: [
        {id: "old-heavy-crew", boatId: "heavy-pursuer", active: true},
        {id: "opening-crew", boatId: "opening-boat", active: true},
      ],
      projectiles: [
        {id: "old-crew-shot", sourceActorId: "old-heavy-crew"},
        {id: "opening-shot", sourceActorId: "opening-crew"},
      ],
    },
    freeCombatAiV164: {
      heavyEncounterId: 12,
      frame: {old: true},
      heavy: {
        encounterId: 12,
        phase: "breach-repairing-v166",
        repairSystem: "engine",
      },
    },
    freeCombatAiV172: {
      repairEncounterId: "12",
      stableRepairDestination: {x: 404, y: 308},
      frame: {old: true},
    },
    freeCombatAiV174: {adoptedEncounterId: 12, frame: {old: true}},
    freeCombatAiV175: {
      repairCommitted: true,
      repairAnnouncementActive: true,
      frame: {old: true},
    },
    freeCombatAiV176: {
      heavyContractId: "old-contract",
      repairAnnouncementKey: "12:turret",
      repairAnchor: {x: 205, y: 119},
      frame: {old: true},
      phaseAnnouncements: {},
    },
  };
}

test("shared lifecycle reset removes only the old heavy and its owned processes", () => {
  const world = worldWithOldHeavy();

  assert.equal(resetHeavyThreatState(world), true);
  assert.equal(world.freeHeavyPursuer.active, false);
  assert.equal(world.freeHeavyPursuer.boat, null);
  assert.deepEqual(world.freeHeavyPursuer.projectiles, []);
  assert.equal(world.freeHeavyPursuer.nextProjectileId, 18);
  assert.deepEqual(world.freeHostileActors.actors.map(actor => actor.id), ["opening-crew"]);
  assert.deepEqual(world.freeHostileActors.projectiles.map(projectile => projectile.id), ["opening-shot"]);
  assert.equal(world.freeCombatAiV164.heavy, null);
  assert.equal(world.freeCombatAiV164.heavyEncounterId, null);
  assert.equal(world.freeCombatAiV172.repairEncounterId, null);
  assert.equal(world.freeCombatAiV172.stableRepairDestination, null);
  assert.equal(world.freeCombatAiV174.adoptedEncounterId, null);
  assert.equal(world.freeCombatAiV175.repairCommitted, false);
  assert.equal(world.freeCombatAiV175.repairAnnouncementActive, false);
  assert.equal(world.freeCombatAiV176.heavyContractId, null);
  assert.equal(world.freeCombatAiV176.repairAnnouncementKey, null);
  assert.equal(world.freeCombatAiV176.repairAnchor, null);
  assert.equal("heavy-pursuer" in world.freeThreatDirector.assignments, false);
  assert.equal("opening-boat" in world.freeThreatDirector.assignments, true);
  assert.equal("old-heavy-crew" in world.freeThreatDirector.actorAssignments, false);
  assert.equal("opening-crew" in world.freeThreatDirector.actorAssignments, true);
});

test("starting any new contract clears the old boss before creating the new encounter", () => {
  const world = worldWithOldHeavy();

  const state = startThreatEncounter(world, 1, "new-contract");

  assert.equal(state.encounterId, 13);
  assert.equal(state.contractId, "new-contract");
  assert.equal(state.level, 1);
  assert.equal(state.heavyStarted, false);
  assert.equal(state.heavyStartsAt, 0);
  assert.equal(world.freeHeavyPursuer.active, false);
  assert.equal(world.freeHeavyPursuer.boat, null);
  assert.deepEqual(world.freeHeavyPursuer.projectiles, []);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "old-heavy-crew"), false);
  assert.equal(world.freeHostileActors.projectiles.some(projectile => projectile.id === "old-crew-shot"), false);
  assert.equal(world.freeCombatAiV164.heavy, null);
  assert.equal(world.freeCombatAiV172.repairEncounterId, null);
  assert.equal(world.events.some(event => event.type === "contract-threat-phase"), false);
  assert.equal(world.events.some(event => event.type === "contract-threat-final-wave"), false);
  assert.equal(world.events.some(event => event.type === "contract-threat-observed"), true);
  assert.deepEqual(world.freeEnemyBoats.boats.map(boat => boat.role), ["observer"]);
});

test("source reset runs before the encounter number advances", () => {
  const source = startThreatEncounter.toString();
  assert.ok(source.indexOf("resetHeavyThreatState(world)") >= 0);
  assert.ok(source.indexOf("resetHeavyThreatState(world)") < source.indexOf("state.encounterId += 1"));
});
