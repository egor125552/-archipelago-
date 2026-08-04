import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhaseAnnouncementsV176,
  normalizeRepairLifecycleV176,
  retireStaleHeavyV176,
  rollbackPrematureThreatPhasesV176,
} from "../public/src/free-roam-combat-ai-model-v176.js";

function staleJournalWorld() {
  return {
    time: 7335.4,
    events: [],
    players: [{
      x: 210,
      y: 180,
      mode: "foot",
      combat: {
        alive: true,
        lockedTargetId: "heavy-turret",
        lastTargetRequestId: "heavy-pursuer",
      },
    }],
    boats: [],
    freeActivities: {
      presence: [true],
      inputs: [{targetId: "heavy-engine"}],
    },
    freeThreatDirector: {
      active: true,
      level: 5,
      encounterId: 13,
      heavyStarted: false,
      heavyStartsAt: 7342.4,
      assignments: {"heavy-pursuer": 0},
    },
    freeHeavyPursuer: {
      active: true,
      encounterId: 12,
      boat: {
        id: "heavy-pursuer",
        active: true,
        destroyed: false,
        x: 205.025,
        y: 118.554,
        hull: 218,
        maxHull: 260,
        engineHealth: 0,
        maxEngineHealth: 180,
        turretHealth: 0,
        maxTurretHealth: 240,
      },
      projectiles: [{id: "old-heavy-shot"}],
    },
    freeCombatAiV164: {
      heavyEncounterId: 12,
      heavy: {
        encounterId: 12,
        phase: "breach-repairing-v166",
        repairSystem: "engine",
        repairPlates: 2,
      },
    },
    freeCombatAiV172: {
      repairEncounterId: "12",
      stableRepairDestination: {x: 404, y: 308},
    },
    freeHostileActors: {
      actors: [
        {id: "old-heavy-crew", boatId: "heavy-pursuer", active: true},
        {id: "v162-opening-13-1", boatId: "opening-boat", active: true},
      ],
    },
  };
}

test("real journal regression: encounter 13 retires the damaged heavy left by encounter 12", () => {
  const world = staleJournalWorld();
  assert.equal(retireStaleHeavyV176(world), true);
  assert.equal(world.freeHeavyPursuer.boat, null);
  assert.equal(world.freeHeavyPursuer.active, false);
  assert.equal(world.freeHeavyPursuer.encounterId, null);
  assert.deepEqual(world.freeHeavyPursuer.projectiles, []);
  assert.equal(world.freeHeavyPursuer.nextProjectileId, 1);
  assert.equal(world.freeCombatAiV164.heavy, null);
  assert.equal(world.freeCombatAiV164.heavyEncounterId, null);
  assert.equal(world.freeCombatAiV172.repairEncounterId, null);
  assert.deepEqual(world.freeCombatAiV172.targetLocks, {});
  assert.equal(world.players[0].combat.lockedTargetId, null);
  assert.equal(world.players[0].combat.lastTargetRequestId, null);
  assert.equal(world.freeActivities.inputs[0].targetId, null);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "old-heavy-crew"), false);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "v162-opening-13-1"), true);
  assert.equal("heavy-pursuer" in world.freeThreatDirector.assignments, false);
});

test("a legitimate heavy outside an active threat-five contract is never retired", () => {
  const world = staleJournalWorld();
  world.freeThreatDirector.active = false;
  assert.equal(retireStaleHeavyV176(world), false);
  assert.ok(world.freeHeavyPursuer.boat);
});

test("an id-less current heavy is not guessed to be stale", () => {
  const world = staleJournalWorld();
  world.freeHeavyPursuer.encounterId = null;
  world.freeCombatAiV164.heavyEncounterId = null;
  world.freeCombatAiV164.heavy.encounterId = null;
  world.freeCombatAiV172.repairEncounterId = null;
  assert.equal(retireStaleHeavyV176(world), false);
  assert.ok(world.freeHeavyPursuer.boat);
});

test("a preserved heavy reference can be forcibly retired after an encounter changes inside one step", () => {
  const world = staleJournalWorld();
  world.freeHeavyPursuer.encounterId = 13;
  world.freeCombatAiV164.heavyEncounterId = 13;
  world.freeCombatAiV164.heavy.encounterId = 13;
  world.freeCombatAiV172.repairEncounterId = "13";
  world.freeThreatDirector.heavyStarted = true;
  assert.equal(retireStaleHeavyV176(world), false);
  assert.equal(retireStaleHeavyV176(world, "encounter-changed-during-step", true), true);
  assert.equal(world.freeHeavyPursuer.boat, null);
});

test("premature second and final phases are rolled back while phase-one forces remain", () => {
  const world = staleJournalWorld();
  world.freeHeavyPursuer.boat = null;
  world.freeHeavyPursuer.active = false;
  world.freeThreatIntelligence = {
    encounterId: 13,
    phase: 3,
    phase2StartedAt: 7335.48,
    phase2BaselineActors: 16,
    phase2Spawned: true,
    finalWaveSpawned: true,
    nextBoatSerial: 6,
  };
  const phaseTwoBoat = {id: "threat-reinforcement-13-2-1", active: true};
  const phaseThreeBoat = {id: "threat-reinforcement-13-3-2", active: true};
  world.freeEnemyBoats = {
    boats: [
      {id: "threat-opening-13-1", active: true},
      phaseTwoBoat,
      phaseThreeBoat,
    ],
    projectiles: [
      {id: "opening-shot", sourcePursuerId: "threat-opening-13-1"},
      {id: "phase-shot", sourcePursuerId: phaseTwoBoat.id},
    ],
  };
  world.freeThreatDirector.boats = [
    {id: "threat-opening-13-1", active: true},
    phaseTwoBoat,
    phaseThreeBoat,
  ];
  world.freeThreatDirector.assignments = {
    "threat-opening-13-1": 0,
    [phaseTwoBoat.id]: 0,
    [phaseThreeBoat.id]: 0,
  };
  world.freeHostileActors.actors.push(
    {id: "threat-phase-13-2-1", boatId: phaseTwoBoat.id, active: true},
    {id: "threat-phase-13-3-1", boatId: phaseThreeBoat.id, active: true},
    {id: "hotfix-crew-13-threat-reinforcement-13-2-1", boatId: phaseTwoBoat.id, active: true},
    {id: "v162-opening-13-9", boatId: phaseThreeBoat.id, active: true},
  );
  world.freeHostileActors.projectiles = [
    {id: "opening-actor-shot", sourceActorId: "v162-opening-13-1"},
    {id: "phase-actor-shot", sourceActorId: "v162-opening-13-9"},
  ];
  world.events = [
    {type: "contract-threat-start", at: 7335.40},
    {type: "contract-threat-phase-two", phase: 2, at: 7335.48},
    {type: "contract-threat-final-wave", phase: 3, at: 7335.48},
    {type: "heavy-armour-breached", at: 7335.44},
    {type: "heavy-systems-disabled", at: 7335.44},
    {type: "heavy-repair-start-v166", at: 7335.44},
    {type: "heavy-tactical-mode-v168", at: 7335.44},
  ];

  assert.equal(rollbackPrematureThreatPhasesV176(world, {eventStart: 0, time: 7335.4}), true);
  assert.deepEqual(world.freeEnemyBoats.boats.map(boat => boat.id), ["threat-opening-13-1"]);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id.startsWith("threat-phase-13-")), false);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id.startsWith("hotfix-crew-13-threat-reinforcement-")), false);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "v162-opening-13-9"), false);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "v162-opening-13-1"), true);
  assert.deepEqual(world.freeEnemyBoats.projectiles.map(projectile => projectile.id), ["opening-shot"]);
  assert.deepEqual(world.freeHostileActors.projectiles.map(projectile => projectile.id), ["opening-actor-shot"]);
  assert.deepEqual(Object.keys(world.freeThreatDirector.assignments), ["threat-opening-13-1"]);
  assert.equal(world.freeThreatIntelligence.phase, 1);
  assert.equal(world.freeThreatIntelligence.phase2Spawned, false);
  assert.equal(world.freeThreatIntelligence.finalWaveSpawned, false);
  assert.equal(world.events.some(event => event.type === "contract-threat-phase-two"), false);
  assert.equal(world.events.some(event => event.type === "contract-threat-final-wave"), false);
  assert.equal(world.events.some(event => event.type.startsWith("heavy-")), false);
  assert.equal(world.events.some(event => event.type === "contract-threat-start"), true);
});

test("twenty-three safe-repair events become one and a committed repair cannot drift", () => {
  const world = {
    time: 7350,
    events: Array.from({length: 23}, (_, index) => ({
      type: "heavy-turret-repair-safe-v172",
      at: 7350 + index * 0.04,
    })),
    players: [{x: 0, y: 0, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeThreatDirector: {active: true, level: 5, encounterId: 13, heavyStarted: true},
    freeHeavyPursuer: {active: true, encounterId: 13, boat: {
      id: "heavy-pursuer", active: true, destroyed: false,
      x: 240, y: 20, heading: 45, speed: 7.2, hull: 170,
      turretHealth: 0, engineHealth: 120,
    }},
    freeCombatAiV164: {heavy: {
      encounterId: 13,
      phase: "breach-repairing-v166",
      repairSystem: "turret",
    }},
    freeCombatAiV175: {repairCommitted: true},
  };

  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: 0, time: 7350}), true);
  const firstAnnouncement = world.events.find(event => event.type === "heavy-turret-repair-safe-v172");
  assert.ok(firstAnnouncement);
  assert.equal(world.events.filter(event => event.type === "heavy-turret-repair-safe-v172").length, 1);
  assert.equal(firstAnnouncement.normalizedV176, true);
  assert.match(firstAnnouncement.text, /241 метров/);
  assert.equal(world.freeHeavyPursuer.boat.speed, 0);
  const anchor = {...world.freeCombatAiV176.repairAnchor};

  world.freeHeavyPursuer.boat.x += 9;
  world.freeHeavyPursuer.boat.y += 7;
  world.freeHeavyPursuer.boat.speed = 5;
  world.events.push({type: "heavy-turret-repair-safe-v172", at: 7350.8});
  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: 23, time: 7350.7}), true);
  assert.equal(world.freeHeavyPursuer.boat.x, anchor.x);
  assert.equal(world.freeHeavyPursuer.boat.y, anchor.y);
  assert.equal(world.freeHeavyPursuer.boat.speed, 0);
  assert.equal(world.events.filter(event => event.type === "heavy-turret-repair-safe-v172").length, 1);
});



test("a real repair interruption resets the announcement lifecycle", () => {
  const world = {
    time: 810,
    events: [{type: "heavy-turret-repair-safe-v172", at: 810}],
    players: [{x: 0, y: 0, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeThreatDirector: {active: true, level: 5, encounterId: 21, heavyStarted: true},
    freeHeavyPursuer: {active: true, encounterId: 21, boat: {
      id: "heavy-pursuer", active: true, destroyed: false,
      x: 250, y: 0, heading: 90, speed: 0, hull: 180,
      turretHealth: 0, engineHealth: 100,
    }},
    freeCombatAiV164: {heavy: {
      encounterId: 21,
      phase: "breach-repairing-v166",
      repairSystem: "turret",
    }},
    freeCombatAiV175: {repairCommitted: true},
  };

  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: 0, time: 810}), true);
  assert.equal(world.events.filter(event => event.type === "heavy-turret-repair-safe-v172").length, 1);

  world.time = 811;
  world.freeCombatAiV175.repairCommitted = false;
  world.events.push({type: "heavy-turret-repair-safe-v172", at: 811});
  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: 1, time: 811}), false);
  assert.equal(world.freeCombatAiV176.repairAnnouncementKey, null);
  assert.equal(world.events.filter(event => event.type === "heavy-turret-repair-safe-v172").length, 1);

  world.time = 812;
  world.freeCombatAiV175.repairCommitted = true;
  world.events.push({type: "heavy-turret-repair-safe-v172", at: 812});
  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: 1, time: 812}), true);
  assert.equal(world.events.filter(event => event.type === "heavy-turret-repair-safe-v172").length, 2);
});

test("actual final-wave announcements are deduplicated", () => {
  const world = {
    time: 200,
    events: [
      {type: "contract-threat-final-wave", phase: 3, at: 200},
      {type: "contract-threat-final-wave", phase: 3, at: 200.01},
    ],
    freeThreatDirector: {active: true, level: 5, encounterId: 13, heavyStarted: true},
  };
  normalizePhaseAnnouncementsV176(world, {eventStart: 0, time: 200});
  assert.equal(world.events.length, 1);
});

test("authoritative chain reaches V176 before V175", async () => {
  const fs = await import("node:fs/promises");
  const hotfix = await fs.readFile(new URL("../public/src/free-roam-combat-ai-hotfix-v163.js", import.meta.url), "utf8");
  const v176 = await fs.readFile(new URL("../public/src/free-roam-combat-ai-model-v176.js", import.meta.url), "utf8");
  assert.match(hotfix, /free-roam-combat-ai-model-v176\.js\?v=1/);
  assert.match(hotfix, /applyCombatAiModelV176\(world, dt, helpers\)/);
  assert.match(v176, /free-roam-combat-ai-model-v175\.js\?v=1/);
  assert.match(v176, /applyCombatAiModelV175/);
});
