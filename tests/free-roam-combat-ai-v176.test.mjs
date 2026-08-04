import test from "node:test";
import assert from "node:assert/strict";
import {
  bindHeavyOwnershipV176,
  finishCombatAiV176Overlay,
  normalizePhaseAnnouncementsV176,
  normalizeRepairLifecycleV176,
  retireStaleHeavyV176,
  rollbackPrematureThreatPhasesV176,
} from "../public/src/free-roam-combat-ai-model-v176.js";

function staleJournalWorld() {
  return {
    time: 7335.4,
    events: [],
    players: [{x: 210, y: 180, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeThreatDirector: {
      active: true,
      level: 5,
      encounterId: 13,
      contractId: "contract-13",
      heavyStarted: false,
      heavyStartsAt: 7342.4,
      assignments: {"heavy-pursuer": 0},
      actorAssignments: {},
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
      projectiles: [
        {id: "old-heavy-crew-shot", sourceActorId: "old-heavy-crew"},
        {id: "opening-shot", sourceActorId: "v162-opening-13-1"},
      ],
    },
  };
}

function repairWorld() {
  return {
    time: 7350,
    events: [],
    players: [{x: 0, y: 0, mode: "foot", combat: {alive: true}}],
    boats: [],
    freeActivities: {presence: [true]},
    freeThreatDirector: {
      active: true,
      level: 5,
      encounterId: 13,
      contractId: "contract-13",
      heavyStarted: true,
    },
    freeHeavyPursuer: {
      active: true,
      encounterId: 13,
      boat: {
        id: "heavy-pursuer",
        active: true,
        destroyed: false,
        x: 240,
        y: 20,
        heading: 45,
        speed: 7.2,
        hull: 170,
        turretHealth: 0,
        engineHealth: 120,
      },
    },
    freeCombatAiV164: {
      heavy: {
        encounterId: 13,
        phase: "breach-repairing-v166",
        repairSystem: "turret",
      },
    },
    freeCombatAiV175: {
      repairCommitted: true,
      repairAnnouncementActive: false,
    },
  };
}

test("real journal regression: encounter 13 retires the damaged heavy left by encounter 12", () => {
  const world = staleJournalWorld();
  assert.equal(retireStaleHeavyV176(world), true);
  assert.equal(world.freeHeavyPursuer.boat, null);
  assert.equal(world.freeHeavyPursuer.active, false);
  assert.deepEqual(world.freeHeavyPursuer.projectiles, []);
  assert.equal(world.freeCombatAiV164.heavy, null);
  assert.equal(world.freeCombatAiV164.heavyEncounterId, null);
  assert.equal(world.freeCombatAiV172.repairEncounterId, null);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "old-heavy-crew"), false);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "v162-opening-13-1"), true);
  assert.equal(world.freeHostileActors.projectiles.some(projectile => projectile.id === "old-heavy-crew-shot"), false);
  assert.equal(world.freeHostileActors.projectiles.some(projectile => projectile.id === "opening-shot"), true);
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

test("same-contract continuity survives an encounter number change", () => {
  const world = staleJournalWorld();
  world.freeCombatAiV176 = {heavyContractId: "contract-13", phaseAnnouncements: {}};
  world.freeHeavyPursuer.v176ContractId = "contract-13";
  world.freeHeavyPursuer.boat.v176ContractId = "contract-13";
  world.freeCombatAiV164.heavy.v176ContractId = "contract-13";
  assert.equal(retireStaleHeavyV176(world), false);
  assert.ok(world.freeHeavyPursuer.boat);
});

test("a new contract retires an old heavy even if an earlier layer already rewrote encounter ids", () => {
  const world = staleJournalWorld();
  world.freeCombatAiV176 = {heavyContractId: "contract-12", phaseAnnouncements: {}};
  world.freeHeavyPursuer.v176ContractId = "contract-12";
  world.freeHeavyPursuer.boat.v176ContractId = "contract-12";
  world.freeCombatAiV164.heavy.v176ContractId = "contract-12";
  world.freeHeavyPursuer.encounterId = 13;
  world.freeCombatAiV164.heavyEncounterId = 13;
  world.freeCombatAiV164.heavy.encounterId = 13;
  world.freeCombatAiV172.repairEncounterId = "13";
  assert.equal(retireStaleHeavyV176(world), true);
  assert.equal(world.freeHeavyPursuer.boat, null);
});

test("ownership is stamped only after the heavy belongs to the current encounter", () => {
  const world = staleJournalWorld();
  assert.equal(bindHeavyOwnershipV176(world), false);
  assert.equal(world.freeCombatAiV176.heavyContractId, null);

  world.freeThreatDirector.heavyStarted = true;
  world.freeHeavyPursuer.encounterId = 13;
  world.freeCombatAiV164.heavyEncounterId = 13;
  world.freeCombatAiV164.heavy.encounterId = 13;
  world.freeCombatAiV172.repairEncounterId = "13";
  assert.equal(bindHeavyOwnershipV176(world), true);
  assert.equal(world.freeCombatAiV176.heavyContractId, "contract-13");
  assert.equal(world.freeHeavyPursuer.boat.v176ContractId, "contract-13");
});

test("premature second and final phases remove boats, generic crews, projectiles and assignments", () => {
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
  world.freeEnemyBoats = {
    boats: [
      {id: "threat-opening-13-1", active: true},
      {id: "threat-reinforcement-13-2-1", active: true},
      {id: "threat-reinforcement-13-3-2", active: true},
    ],
    projectiles: [
      {id: "phase-two-shot", sourceBoatId: "threat-reinforcement-13-2-1"},
      {id: "opening-boat-shot", sourceBoatId: "threat-opening-13-1"},
    ],
  };
  world.freeHostileActors.actors.push(
    {
      id: "hotfix-crew-threat-reinforcement-13-2-1-1",
      boatId: "threat-reinforcement-13-2-1",
      active: true,
    },
    {id: "threat-phase-13-3-1", boatId: "threat-reinforcement-13-3-2", active: true},
  );
  world.freeHostileActors.projectiles.push(
    {
      id: "generic-crew-shot",
      sourceActorId: "hotfix-crew-threat-reinforcement-13-2-1-1",
    },
  );
  world.freeThreatDirector.assignments = {
    "threat-opening-13-1": 0,
    "threat-reinforcement-13-2-1": 0,
    "threat-reinforcement-13-3-2": 0,
  };
  world.freeThreatDirector.actorAssignments = {
    "hotfix-crew-threat-reinforcement-13-2-1-1": 0,
    "threat-phase-13-3-1": 0,
  };
  world.events = [
    {type: "contract-threat-start", at: 7335.40},
    {type: "contract-threat-phase-two", phase: 2, at: 7335.48},
    {type: "contract-threat-final-wave", phase: 3, at: 7335.48},
    {type: "contract-threat-phase", phase: 3, at: 7335.49},
    {
      type: "enemy-boat-fired",
      sourceBoatId: "threat-reinforcement-13-2-1",
      at: 7335.49,
    },
    {type: "heavy-armour-breached", at: 7335.44},
  ];

  assert.equal(rollbackPrematureThreatPhasesV176(world, {eventStart: 0, time: 7335.4}), true);
  assert.deepEqual(world.freeEnemyBoats.boats.map(boat => boat.id), ["threat-opening-13-1"]);
  assert.deepEqual(world.freeEnemyBoats.projectiles.map(projectile => projectile.id), ["opening-boat-shot"]);
  assert.equal(
    world.freeHostileActors.actors.some(actor => actor.id === "hotfix-crew-threat-reinforcement-13-2-1-1"),
    false,
  );
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "threat-phase-13-3-1"), false);
  assert.equal(world.freeHostileActors.actors.some(actor => actor.id === "v162-opening-13-1"), true);
  assert.equal(world.freeHostileActors.projectiles.some(projectile => projectile.id === "generic-crew-shot"), false);
  assert.deepEqual(Object.keys(world.freeThreatDirector.assignments), ["threat-opening-13-1"]);
  assert.deepEqual(Object.keys(world.freeThreatDirector.actorAssignments), []);
  assert.equal(world.freeThreatIntelligence.phase, 1);
  assert.equal(world.freeThreatIntelligence.phase2Spawned, false);
  assert.equal(world.freeThreatIntelligence.finalWaveSpawned, false);
  assert.equal(world.freeThreatIntelligence.nextBoatSerial, 6);
  assert.equal(world.events.some(event => event.type === "contract-threat-phase-two"), false);
  assert.equal(world.events.some(event => event.type === "contract-threat-final-wave"), false);
  assert.equal(world.events.some(event => event.type === "contract-threat-phase" && event.phase === 3), false);
  assert.equal(world.events.some(event => event.type === "enemy-boat-fired"), false);
  assert.equal(world.events.some(event => event.type === "heavy-armour-breached"), false);
  assert.equal(world.events.some(event => event.type === "contract-threat-start"), true);
});

test("the authoritative finish step rolls premature phases back both before and after V175", () => {
  const body = finishCombatAiV176Overlay.toString();
  const calls = body.match(/rollbackPrematureThreatPhasesV176/g) || [];
  assert.equal(calls.length, 2);
  assert.ok(body.indexOf("rollbackPrematureThreatPhasesV176") < body.indexOf("applyCombatAiModelV175"));
  assert.ok(body.lastIndexOf("rollbackPrematureThreatPhasesV176") > body.indexOf("applyCombatAiModelV175"));
});

test("twenty-three safe-repair events become one and a committed repair cannot drift", () => {
  const world = repairWorld();
  world.events = Array.from({length: 23}, (_, index) => ({
    type: "heavy-turret-repair-safe-v172",
    at: 7350 + index * 0.04,
  }));

  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: 0, time: 7350}), true);
  assert.equal(world.events.filter(event => event.type === "heavy-turret-repair-safe-v172").length, 1);
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

test("a real abort permits exactly one new repair announcement after the next genuine restart", () => {
  const world = repairWorld();
  world.events.push({type: "heavy-turret-repair-safe-v172", at: 7350});
  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: 0, time: 7350}), true);

  const abortStart = world.events.length;
  world.freeCombatAiV175.repairCommitted = false;
  world.events.push({
    type: "heavy-tactical-mode-v168",
    mode: "repair-aborted",
    at: 7351,
  });
  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: abortStart, time: 7351}), false);
  assert.equal(world.freeCombatAiV175.repairAnnouncementActive, false);

  const restartStart = world.events.length;
  world.freeCombatAiV175.repairCommitted = true;
  world.events.push(
    {type: "heavy-turret-repair-safe-v172", at: 7352},
    {type: "heavy-turret-repair-safe-v172", at: 7352.03},
  );
  assert.equal(normalizeRepairLifecycleV176(world, {eventStart: restartStart, time: 7352}), true);
  assert.equal(world.events.filter(event => event.type === "heavy-turret-repair-safe-v172").length, 2);
  assert.equal(world.freeHeavyPursuer.boat.speed, 0);
});

test("actual final-wave announcements are deduplicated", () => {
  const world = {
    time: 200,
    events: [
      {type: "contract-threat-final-wave", phase: 3, at: 200},
      {type: "contract-threat-final-wave", phase: 3, at: 200.01},
    ],
    freeThreatDirector: {
      active: true,
      level: 5,
      encounterId: 13,
      contractId: "contract-13",
      heavyStarted: true,
    },
  };
  normalizePhaseAnnouncementsV176(world, {eventStart: 0, time: 200});
  assert.equal(world.events.length, 1);
});

test("authoritative chain reaches V176 before V175", async () => {
  const fs = await import("node:fs/promises");
  const hotfix = await fs.readFile(
    new URL("../public/src/free-roam-combat-ai-hotfix-v163.js", import.meta.url),
    "utf8",
  );
  const v176 = await fs.readFile(
    new URL("../public/src/free-roam-combat-ai-model-v176.js", import.meta.url),
    "utf8",
  );
  assert.match(hotfix, /free-roam-combat-ai-model-v176\.js\?v=1/);
  assert.match(hotfix, /applyCombatAiModelV176\(world, dt, helpers\)/);
  assert.match(v176, /free-roam-combat-ai-model-v175\.js\?v=1/);
  assert.match(v176, /applyCombatAiModelV175/);
});
