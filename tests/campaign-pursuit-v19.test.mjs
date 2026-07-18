import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  CONFIG,
  command,
  createGame,
  getRoutePlan,
  getView,
  serialize,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v16.js";
import {
  BOATS,
  OPERATIONS,
  SHOP_ITEMS,
  normalizeProfile,
  purchaseUpgrade,
  recordOperation,
  selectBoat,
} from "../public/src/progression.js";

const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds && state.phase === "playing"; elapsed += dt) {
    events.push(...step(state, dt));
  }
  return events;
}

function segmentClearance(start, end, hazard) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const square = dx * dx + dy * dy;
  const amount = Math.max(0, Math.min(1, ((hazard.x - start.x) * dx + (hazard.y - start.y) * dy) / square));
  return Math.hypot(start.x + dx * amount - hazard.x, start.y + dy * amount - hazard.y)
    - hazard.radius - CONFIG.collisionMargin;
}

function approach(state, target, error = 6, dt = 0.05) {
  state.sonar.cooldown = 0;
  command(state, "sonar");
  state.boat.heading = wrap(bearing(state.boat, target) + error);
  setControl(state, "forward", true);
  const events = [];
  for (let elapsed = 0; elapsed < 100 && state.phase === "playing"; elapsed += dt) {
    events.push(...step(state, dt));
    const view = getView(state);
    if (target.id !== "harbor" && view.navigation.rescueMode) break;
    if (target.id === "harbor" && state.won) break;
  }
  return events;
}

function hitHazard({speed = 18, boatId = "strizh", upgrades = {}, solid = false} = {}) {
  const state = createGame({mode: "solo", progression: {level: 4, boatId, upgrades}});
  startGame(state);
  state.training.safetyEnabled = false;
  const hazard = state.world.hazards.find(item => solid ? !item.breakable : item.breakable);
  state.boat.x = hazard.x;
  state.boat.y = hazard.y - hazard.radius - CONFIG.collisionMargin - 0.4;
  state.boat.heading = 0;
  state.boat.speed = speed;
  state.boat.throttle = 1;
  return {state, hazard, events: run(state, 0.5)};
}

test("campaign grows to six operations and migrates completed level three profiles", () => {
  assert.equal(OPERATIONS.length, 6);
  assert.equal(BOATS.length, 4);
  assert.ok(SHOP_ITEMS.some(item => item.id === "ram-keel"));
  assert.ok(SHOP_ITEMS.some(item => item.id === "debris-tools"));
  const migrated = normalizeProfile({
    unlockedLevel: 3,
    selectedLevel: 3,
    bestByLevel: {1: 3000, 2: 3200, 3: 3400},
  });
  assert.equal(migrated.unlockedLevel, 4);
  assert.equal(selectBoat(migrated, "burevestnik").selectedBoat, "burevestnik");
  const completed = recordOperation(migrated, {level: 4, won: true, reward: 2000, score: 3600});
  assert.equal(completed.unlockedLevel, 5);
  const keel = purchaseUpgrade(completed, "ram-keel");
  assert.equal(keel.ok, true);
});

test("new maps expand, contain mostly breakable wrecks and keep direct sonar corridors wide", () => {
  let previousNorth = 155;
  let previousHazards = 4;
  for (const level of [4, 5, 6]) {
    const state = createGame({progression: {level, boatId: "strizh", upgrades: {}}});
    assert.ok(state.world.bounds.maxY > previousNorth);
    assert.ok(state.world.hazards.length > previousHazards);
    assert.ok(state.world.hazards.filter(item => item.breakable).length > state.world.hazards.length / 2);
    const legs = [
      [state.world.harbor, state.world.survivors[0]],
      [state.world.survivors[0], state.world.survivors[1]],
      [state.world.survivors[1], state.world.harbor],
    ];
    for (const [from, to] of legs) {
      for (const hazard of state.world.hazards) {
        assert.ok(segmentClearance(from, to, hazard) > 20, `${level}/${hazard.id}`);
      }
    }
    previousNorth = state.world.bounds.maxY;
    previousHazards = state.world.hazards.length;
  }
});

test("advanced risk routes exist on every leg and remain physically passable", () => {
  for (const level of [4, 5, 6]) {
    for (const targetId of ["survivor-a", "survivor-b", "harbor"]) {
      const state = createGame({progression: {level, boatId: "grom", upgrades: {}}});
      state.riskRoute.selectedRisk = true;
      const start = targetId === "survivor-a"
        ? state.world.harbor
        : targetId === "survivor-b"
          ? state.world.survivors[0]
          : state.world.survivors[1];
      if (targetId === "harbor") {
        state.rescued = 2;
        state.world.survivors.forEach(item => { item.rescued = true; });
      }
      const plan = getRoutePlan(state, targetId);
      assert.equal(plan.length, 3, `${level}/${targetId}`);
      let previous = start;
      for (const point of plan) {
        for (const hazard of state.world.hazards) {
          assert.ok(segmentClearance(previous, point, hazard) > 7, `${level}/${targetId}/${hazard.id}`);
        }
        previous = point;
      }
    }
  }
});

test("speed makes wreck deformation worse while concrete remains unbreakable", () => {
  const low = hitHazard({speed: 9});
  const high = hitHazard({speed: 18});
  const lowHit = low.events.find(event => event.type === "collision");
  const highHit = high.events.find(event => event.type === "collision");
  assert.ok(lowHit && highHit);
  assert.ok(highHit.damage > lowHit.damage * 2.5, `${lowHit.damage} -> ${highHit.damage}`);
  assert.ok(highHit.deformationDamage > lowHit.deformationDamage);

  const solid = hitHazard({speed: 24, boatId: "grom", upgrades: {"ram-keel": true}, solid: true});
  assert.ok(solid.events.some(event => event.type === "collision"));
  assert.equal(solid.events.some(event => event.type === "wreck-destroyed"), false);
  assert.ok(solid.state.world.hazards.some(item => item.id === solid.hazard.id));
});

test("a strong ram breaks light wreckage and embeds a removable speed-limiting fragment", () => {
  const {state, hazard, events} = hitHazard({
    speed: 24,
    boatId: "grom",
    upgrades: {"ram-keel": true, "debris-tools": true},
  });
  assert.ok(events.some(event => event.type === "wreck-destroyed"));
  assert.ok(events.some(event => event.type === "debris-embedded"));
  assert.equal(state.world.hazards.some(item => item.id === hazard.id), false);
  const penalizedSpeed = state.boat.maxSpeedMultiplier;
  assert.equal(getView(state).debris.count, 1);
  assert.ok(penalizedSpeed < state.boat.baseMaxSpeedMultiplier);

  state.boat.speed = 0;
  state.boat.throttle = 0;
  assert.equal(command(state, "debris-remove").ok, true);
  const early = run(state, 5.2);
  assert.equal(early.some(event => event.type === "debris-remove-complete"), false);
  const completed = run(state, 0.5);
  assert.ok(completed.some(event => event.type === "debris-remove-complete"));
  assert.equal(getView(state).debris.count, 0);
  assert.equal(state.boat.maxSpeedMultiplier, state.boat.baseMaxSpeedMultiplier);
});

test("moving interrupts debris extraction and coop keeps it with the systems operator", () => {
  const state = createGame({mode: "coop", progression: {level: 4, boatId: "strizh", upgrades: {}}});
  startGame(state);
  state.debris.pieces.push({id: "test", leak: 1});
  state.boat.embeddedDebris = 1;
  assert.equal(command(state, "debris-remove", "captain").reason, "crew-only");
  assert.equal(command(state, "debris-remove", "crew").ok, true);
  state.boat.speed = 1;
  const events = step(state, 0.1);
  assert.ok(events.some(event => event.type === "debris-remove-cancel"));
  assert.equal(state.debris.progress, 0);
});

test("new boat models are materially distinct and Grom is the fastest armored rammer", () => {
  const storm = createGame({progression: {level: 4, boatId: "burevestnik", upgrades: {}}});
  const grom = createGame({progression: {level: 6, boatId: "grom", upgrades: {}}});
  assert.ok(storm.boat.maxSpeedMultiplier > 1.25);
  assert.ok(storm.boat.collisionDamageMultiplier > 1);
  assert.ok(grom.boat.maxSpeedMultiplier > 1.5);
  assert.ok(grom.boat.armor >= 24);
  assert.ok(grom.boat.collisionDamageMultiplier < 0.7);
});

test("hunter waits, pursues with cooldown-separated rams and backs off during flood emergency", () => {
  const state = createGame({progression: {level: 6, boatId: "strizh", upgrades: {}}});
  startGame(state);
  state.training.safetyEnabled = false;
  const before = run(state, CONFIG.hunterSpawnDelay - 0.2);
  assert.equal(before.some(event => event.type === "hunter-ram"), false);
  const events = run(state, 35);
  const rams = events.filter(event => event.type === "hunter-ram");
  assert.ok(rams.length >= 2, `rams: ${rams.length}`);
  assert.ok(state.boat.hull < 75);
  while (!state.damageControl.floodEmergency && state.phase === "playing") step(state, 0.05);
  const count = state.eventLog.filter(event => event.type === "hunter-ram").length;
  const emergencyEvents = run(state, 8);
  assert.equal(emergencyEvents.some(event => event.type === "hunter-ram"), false);
  assert.equal(state.eventLog.filter(event => event.type === "hunter-ram").length, count);
});

test("decoy is limited, accessible to the systems role and redirects the active hunter", () => {
  const state = createGame({mode: "coop", progression: {level: 6, boatId: "grom", upgrades: {}}});
  startGame(state);
  run(state, CONFIG.hunterSpawnDelay + 0.2);
  assert.equal(command(state, "hunter-decoy", "captain").reason, "crew-only");
  const deployed = command(state, "hunter-decoy", "crew");
  assert.equal(deployed.ok, true);
  assert.ok(deployed.events.some(event => event.type === "hunter-decoy"));
  assert.equal(getView(state).hunter.decoyCharges, 1);
  assert.equal(getView(state).hunter.decoyActive, true);
  run(state, 8.2);
  assert.equal(getView(state).hunter.decoyActive, false);
});

test("ordinary audible route completes all three new operations without obstacle collisions", () => {
  for (const level of [4, 5, 6]) {
    for (const dt of [0.033, 0.071, 0.12]) {
      for (const error of [-9, 0, 9]) {
        const state = createGame({
          mode: "solo",
          progression: {
            level,
            boatId: level === 6 ? "grom" : "burevestnik",
            upgrades: {"mini-armor": true, "high-flow-pump": true, "ram-keel": true, "debris-tools": true},
          },
        });
        startGame(state);
        state.training.safetyEnabled = false;
        const events = [];
        for (const survivor of state.world.survivors) {
          events.push(...approach(state, survivor, error, dt));
          assert.ok(distance(state.boat, survivor) <= CONFIG.rescueRadius);
          if (level === 6 && getView(state).hunter.active) command(state, "hunter-decoy");
          setControl(state, "rescue", true);
          events.push(...run(state, 3.7, dt));
          setControl(state, "rescue", false);
          assert.equal(survivor.rescued, true, `${level}/${dt}/${error}`);
        }
        events.push(...approach(state, state.world.harbor, error, dt));
        assert.equal(state.won, true, `level ${level}/${dt}/${error}: ${state.message}`);
        assert.equal(events.some(event => event.type === "collision"), false);
        assert.ok(state.progression.rewardCredits >= 950);
      }
    }
  }
});

test("long hunter stress stays finite and serializable", () => {
  const state = createGame({progression: {level: 6, boatId: "grom", upgrades: {"high-flow-pump": true}}});
  startGame(state);
  state.training.safetyEnabled = false;
  setControl(state, "pump", true);
  for (let index = 0; index < 24_000 && state.phase === "playing"; index += 1) {
    if (index % 79 === 0) setControl(state, "left", !state.controls.left);
    if (index % 113 === 0) setControl(state, "right", !state.controls.right);
    if (index % 181 === 0) setControl(state, "forward", !state.controls.forward);
    step(state, 0.025);
    for (const value of [state.boat.x, state.boat.y, state.boat.hull, state.boat.water, state.hunter.x, state.hunter.y, state.hunter.heading, state.hunter.speed]) {
      assert.ok(Number.isFinite(value));
    }
  }
  assert.doesNotThrow(() => JSON.parse(serialize(state)));
});

test("release exposes six levels, new controls, cache generation and procedural pursuit audio", async () => {
  const [html, app, audio, core] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/audio-engine-v11.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/game-core-v16.js", import.meta.url), "utf8"),
  ]);
  for (const id of ["operation4", "operation5", "operation6", "boatBurevestnik", "boatGrom", "debrisButton", "decoyButton", "hunterStatus"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /game-core-v18\.js\?v=27\.0/);
  assert.match(html, /audio-engine-v13\.js\?v=27\.0/);
  assert.match(app, /debris-remove/);
  assert.match(app, /hunter-decoy/);
  assert.match(audio, /startHunterEngine/);
  assert.match(audio, /playMetalBurst/);
  assert.match(core, /steerHunterAroundHazards/);
  assert.match(core, /hunterRamCooldown/);
});
