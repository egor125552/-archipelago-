import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeThreatEventsV175,
  applyRepairHysteresisV175,
  applyDamagedEngineCautionV175,
  applyMassBombAdaptationV175,
  applyEscortRepairCoverV175,
} from "../public/src/free-roam-combat-ai-model-v175.js";

function world() {
  return {
    time: 100,
    events: [],
    players: [{x: 0, y: 0, combat: {alive: true}}],
    freeActivities: {presence: [true]},
    freeThreatDirector: {encounterId: 12, active: true, level: 5, boats: []},
    freeHeavyPursuer: {boat: {id: "heavy-pursuer", x: 240, y: 0, active: true, destroyed: false, hull: 170, engineHealth: 20, maxEngineHealth: 180, turretHealth: 0, maxTurretHealth: 240, speed: 0}},
    freeCombatAiV164: {heavy: {phase: "breach-escaping-v166", repairSystem: "turret", repairProgress: 2, repairPlates: 2}},
    freeCombatAiV172: {stableRepairDestination: {x: 404, y: 308}},
    freeHostileActors: {actors: []},
  };
}

test("journal regression: duplicate phases, ceasefires and windups are collapsed", () => {
  const w = world();
  w.freeHostileActors.actors = [{id: "crew", boatId: "heavy-pursuer", state: "water", active: true, destroyed: false, health: 20}];
  w.events = [
    {type: "contract-threat-phase-two", phase: 2, at: 100, text: "a"},
    {type: "contract-threat-phase", phase: 2, at: 100.04, text: "b"},
    {type: "pursuer-ceasefire", targetPlayer: 0, at: 100.01},
    {type: "pursuer-ceasefire", targetPlayer: 0, at: 100.02},
    {type: "heavy-gun-windup", at: 100.1},
    {type: "heavy-gun-windup", at: 100.3},
    {type: "contract-cleared", at: 100.4},
  ];
  normalizeThreatEventsV175(w, 0);
  assert.equal(w.events.filter(event => Number(event.phase) === 2).length, 1);
  assert.equal(w.events.filter(event => event.type === "pursuer-ceasefire").length, 1);
  assert.equal(w.events.filter(event => event.type === "heavy-gun-windup").length, 1);
  assert.equal(w.events.some(event => event.type === "contract-cleared"), false);
});

test("forty-seven repair-start events become one announcement", () => {
  const w = world();
  w.freeCombatAiV175 = {frame: null, encounterId: null, announcedPhases: {}, repairCommitted: true, repairAnnouncementActive: false, lastWindupAt: -Infinity, massBombAlertUntil: 0};
  w.freeCombatAiV164.heavy.phase = "breach-repairing-v166";
  w.events = Array.from({length: 47}, (_, index) => ({type: "heavy-turret-repair-safe-v172", at: 100 + index * 0.04}));
  normalizeThreatEventsV175(w, 0);
  assert.equal(w.events.filter(event => event.type === "heavy-turret-repair-safe-v172").length, 1);
});

test("repair has a twenty metre hysteresis band", () => {
  const w = world();
  w.freeHeavyPursuer.boat.x = 230;
  assert.equal(applyRepairHysteresisV175(w), false);
  w.freeHeavyPursuer.boat.x = 238;
  assert.equal(applyRepairHysteresisV175(w), true);
  w.freeHeavyPursuer.boat.x = 225;
  assert.equal(applyRepairHysteresisV175(w), true);
  w.freeHeavyPursuer.boat.x = 210;
  assert.equal(applyRepairHysteresisV175(w), false);
});

test("heavy reacts before its engine reaches zero", () => {
  const w = world();
  w.freeHeavyPursuer.boat.turretHealth = 160;
  w.freeCombatAiV164.heavy.repairSystem = null;
  w.freeCombatAiV164.heavy.phase = "combat";
  assert.equal(applyDamagedEngineCautionV175(w), true);
  assert.equal(w.freeCombatAiV164.heavy.phase, "retreating");
});

test("the player's mass-bomb tactic changes spacing and repair cover", () => {
  const w = world();
  w.freeHostileActors.actors = [{id: "a", active: true, state: "ground"}, {id: "b", active: true, state: "ground"}];
  w.freeThreatDirector.boats = [{id: "escort", active: true}];
  w.events = [1, 2, 3].map(index => ({type: "enemy-actor-killed", projectileId: `mega-bomb-${index}`}));
  assert.equal(applyMassBombAdaptationV175(w, 0), true);
  assert.equal(w.freeHostileActors.actors.every(actor => actor.avoidMassExplosives), true);
  assert.equal(w.freeThreatDirector.boats[0].minimumAllySpacing, 26);
  assert.equal(applyEscortRepairCoverV175(w), true);
  assert.equal(w.freeThreatDirector.boats[0].tacticalRole, "screen-heavy-repair-v175");
});

test("V175 remains directly below the authoritative V176 layer", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../public/src/free-roam-combat-ai-model-v176.js", import.meta.url), "utf8"));
  assert.match(source, /free-roam-combat-ai-model-v175\.js\?v=1/);
  assert.match(source, /applyCombatAiModelV175/);
});
