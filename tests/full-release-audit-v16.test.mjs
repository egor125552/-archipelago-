import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  CONFIG,
  command,
  createGame,
  deserialize,
  getRoutePlan,
  getView,
  serialize,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v13.js";

const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function createStarted({level = 1, mode = "solo", timed = false, upgrades = {}, boatId = "strizh"} = {}) {
  const state = createGame({mode, timed, progression: {level, boatId, upgrades}});
  startGame(state);
  return state;
}

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
  const amount = square > 0
    ? Math.max(0, Math.min(1, ((hazard.x - start.x) * dx + (hazard.y - start.y) * dy) / square))
    : 0;
  return Math.hypot(start.x + dx * amount - hazard.x, start.y + dy * amount - hazard.y)
    - hazard.radius - CONFIG.collisionMargin;
}

function ordinaryApproach(state, target, error, dt) {
  state.sonar.cooldown = 0;
  assert.equal(command(state, "sonar").ok, true);
  state.boat.heading = wrap(bearing(state.boat, target) + error);
  setControl(state, "forward", true);
  const events = [];
  for (let elapsed = 0; elapsed < 100 && state.phase === "playing"; elapsed += dt) {
    events.push(...step(state, dt));
    const view = getView(state);
    if (target.id !== "harbor" && view.navigation.rescueMode) break;
    if (target.id === "harbor" && state.won) break;
  }
  setControl(state, "forward", false);
  return events;
}

function riskApproach(state, target, dt = 0.08) {
  state.sonar.cooldown = 0;
  const sonar = command(state, "sonar");
  assert.equal(sonar.ok, true);
  setControl(state, "forward", true);
  const events = [...(sonar.events || [])];
  for (let elapsed = 0; elapsed < 120 && state.phase === "playing"; elapsed += dt) {
    const view = getView(state);
    const relative = view.navigation?.targetRelativeAngle;
    if (Number.isFinite(relative)) state.boat.heading = wrap(state.boat.heading + relative);
    events.push(...step(state, dt));
    const next = getView(state);
    if (target.id !== "harbor" && next.navigation.rescueMode) break;
    if (target.id === "harbor" && state.won) break;
  }
  setControl(state, "forward", false);
  return events;
}

test("route selector keeps ordinary sonar as the default and unlocks risk at level two", () => {
  const levelOne = createStarted({level: 1});
  assert.equal(command(levelOne, "risk-route-toggle").reason, "locked");
  assert.equal(getView(levelOne).riskRoute.enabled, false);

  const levelTwo = createStarted({level: 2});
  const ordinary = getRoutePlan(levelTwo, "survivor-a");
  assert.deepEqual(ordinary.map(point => point.id), ["survivor-a"]);
  assert.equal(getView(levelTwo).navigation.directMode, true);

  assert.equal(command(levelTwo, "sonar").ok, true);
  const directGuide = getView(levelTwo).navigation.routeWaypointId;
  assert.equal(command(levelTwo, "risk-route-toggle").ok, true);
  const pending = getView(levelTwo);
  assert.equal(pending.riskRoute.selectedRisk, true);
  assert.equal(pending.riskRoute.enabled, false);
  assert.equal(pending.riskRoute.selectionPending, true);
  assert.equal(pending.navigation.routeWaypointId, directGuide);
  levelTwo.sonar.cooldown = 0;
  const sonar = command(levelTwo, "sonar");
  const view = getView(levelTwo);
  assert.equal(view.riskRoute.enabled, true);
  assert.equal(view.riskRoute.active, true);
  assert.equal(view.navigation.guideIsWaypoint, true);
  assert.equal(view.navigation.courseHold, false);
  assert.equal(view.training.safetySuspendedForRisk, true);
  assert.ok(sonar.events.some(event => event.riskRoute === true));
});

test("risk routes use explicit entrance and exit points with narrow but positive physical clearance", () => {
  for (const level of [2, 3]) {
    const state = createStarted({level});
    command(state, "risk-route-toggle");
    const routeCases = [
      {targetId: "survivor-a", start: state.world.harbor, rescued: 0},
      {targetId: "survivor-b", start: state.world.survivors[0], rescued: 1},
      {targetId: "harbor", start: state.world.survivors[1], rescued: 2},
    ];
    for (const routeCase of routeCases) {
      state.rescued = routeCase.rescued;
      state.world.survivors[0].rescued = routeCase.rescued >= 1;
      state.world.survivors[1].rescued = routeCase.rescued >= 2;
      let previous = routeCase.start;
      for (const point of getRoutePlan(state, routeCase.targetId)) {
        for (const hazard of state.world.hazards) {
          const clearance = segmentClearance(previous, point, hazard);
          assert.ok(clearance > 2.25, `${level}/${routeCase.targetId}/${point.id}/${hazard.id}: ${clearance}`);
        }
        previous = point;
      }
    }
  }
});

test("a clean risk gate rewards once and cannot be farmed by toggling the sonar mode", () => {
  const state = createStarted({level: 2});
  command(state, "risk-route-toggle");
  command(state, "sonar");
  const firstPlan = getRoutePlan(state, "survivor-a").slice(0, -1);
  let events = [];
  for (const point of firstPlan) {
    state.boat.x = point.x;
    state.boat.y = point.y;
    events.push(...step(state, 0.01));
  }
  assert.ok(events.some(event => event.type === "risk-gate-entered"));
  assert.ok(events.some(event => event.type === "risk-gate-cleared"));
  assert.equal(state.score, CONFIG.riskGateScoreBonus);
  assert.equal(state.riskRoute.creditBonus, CONFIG.riskGateCreditBonus);

  command(state, "risk-route-toggle");
  command(state, "risk-route-toggle");
  state.sonar.cooldown = 0;
  command(state, "sonar");
  events = [];
  for (const point of getRoutePlan(state, "survivor-a").slice(0, -1)) {
    state.boat.x = point.x;
    state.boat.y = point.y;
    events.push(...step(state, 0.01));
  }
  assert.ok(events.some(event => event.type === "risk-gate-repeat"));
  assert.equal(state.score, CONFIG.riskGateScoreBonus);
  assert.equal(state.riskRoute.creditBonus, CONFIG.riskGateCreditBonus);
});

test("a collision during the narrow section invalidates only that gate bonus", () => {
  const state = createStarted({level: 2});
  command(state, "risk-route-toggle");
  command(state, "sonar");
  const [entry, exit] = getRoutePlan(state, "survivor-a");
  state.boat.x = entry.x;
  state.boat.y = entry.y;
  step(state, 0.01);

  const hazard = state.world.hazards.find(item => item.id === "wreck-gate");
  state.boat.x = hazard.x;
  state.boat.y = hazard.y - hazard.radius - CONFIG.collisionMargin - 0.15;
  state.boat.heading = 0;
  state.boat.speed = 9;
  const collisionEvents = step(state, 0.08);
  assert.ok(collisionEvents.some(event => event.type === "collision"));
  assert.equal(state.riskRoute.gateFailed, true);

  state.boat.x = exit.x;
  state.boat.y = exit.y;
  const exitEvents = step(state, 0.01);
  assert.ok(exitEvents.some(event => event.type === "risk-gate-failed"));
  assert.equal(state.riskRoute.creditBonus, 0);
  assert.equal(state.score, 0);
});

test("manual solo pumping is stronger than helper pumping and the upgrade stacks", () => {
  const helper = createStarted({level: 2});
  helper.boat.water = 60;
  helper.boat.leak = 0;
  run(helper, 1);

  const manual = createStarted({level: 2});
  manual.boat.water = 60;
  manual.boat.leak = 0;
  setControl(manual, "pump", true);
  run(manual, 1);
  assert.ok(helper.boat.water - manual.boat.water > 2.5, `${helper.boat.water} vs ${manual.boat.water}`);

  const upgraded = createStarted({level: 2, upgrades: {"high-flow-pump": true}});
  upgraded.boat.water = 60;
  upgraded.boat.leak = 0;
  setControl(upgraded, "pump", true);
  run(upgraded, 1);
  assert.ok(manual.boat.water - upgraded.boat.water > 2.6, `${manual.boat.water} vs ${upgraded.boat.water}`);
});

test("coop roles cannot steal the anchor or sonar route selector", () => {
  const state = createStarted({level: 2, mode: "coop"});
  state.boat.speed = 10;
  assert.equal(command(state, "anchor", "crew").reason, "captain-only");
  assert.equal(state.boat.speed, 10);
  assert.equal(command(state, "risk-route-toggle", "captain").reason, "crew-only");
  assert.equal(command(state, "risk-route-toggle", "crew").ok, true);
});

test("engine repair requires a nearly stopped boat, fuel and controlled flooding", () => {
  const state = createStarted({level: 2});
  state.boat.engineStalled = true;
  state.boat.speed = 12;
  assert.equal(command(state, "repair").reason, "too-fast");
  assert.equal(state.boat.repairProgress, 0);
  assert.equal(getView(state).canRepair, false);

  state.boat.speed = 0;
  state.boat.fuel = 0;
  assert.equal(command(state, "repair").reason, "no-fuel");
  assert.equal(getView(state).canRepair, false);

  state.boat.fuel = 50;
  state.damageControl.floodEmergency = true;
  assert.equal(command(state, "repair").reason, "flood-first");
});

test("zero fuel allows coasting but ends a stopped soft-lock outside harbor", () => {
  const stranded = createStarted({level: 2});
  stranded.boat.fuel = 0;
  stranded.boat.speed = 2;
  const events = run(stranded, 120, 0.1);
  assert.equal(stranded.phase, "finished");
  assert.equal(stranded.ending, "fuel");
  assert.ok(events.some(event => event.type === "lose" && event.reason === "fuel"));

  const docking = createStarted({level: 2});
  docking.rescued = 2;
  docking.world.survivors.forEach(survivor => { survivor.rescued = true; });
  docking.boat.x = docking.world.harbor.x;
  docking.boat.y = docking.world.harbor.y;
  docking.boat.speed = 0;
  docking.boat.fuel = 0;
  step(docking, 0.05);
  assert.equal(docking.won, true);
  assert.equal(docking.ending, "harbor");
});

test("late timed flooding receives the full emergency window and restart grace", () => {
  const state = createStarted({level: 2, timed: true});
  state.elapsed = 239.7;
  state.totalElapsed = 239.7;
  state.boat.hull = 0;
  const startEvents = step(state, 0.05);
  assert.ok(startEvents.some(event => event.type === "flood-emergency-start"));
  assert.equal(state.phase, "playing");
  assert.ok(state.elapsed <= CONFIG.missionDuration - CONFIG.emergencyRestartGrace);
  assert.ok(getView(state).damageControl.floodEmergencyRemaining >= 44.9);

  const frozenElapsed = state.elapsed;
  run(state, 2);
  assert.ok(Math.abs(state.elapsed - frozenElapsed) < 1e-6);
  state.boat.water = CONFIG.floodRecoveryWater;
  state.boat.leak = CONFIG.floodRecoveryLeak;
  state.boat.hull = CONFIG.floodRecoveryHull;
  const recovered = step(state, 0.05);
  assert.ok(recovered.some(event => event.type === "flood-emergency-recovered"));
  assert.ok(getView(state).remaining >= CONFIG.emergencyRestartGrace - 0.1);
});

test("free-mode victory score uses total play time instead of shifted legacy time", () => {
  const state = createStarted({level: 1});
  state.elapsed = 100;
  state.totalElapsed = 340;
  state.score = 1000;
  state.rescued = 2;
  state.world.survivors.forEach(survivor => { survivor.rescued = true; });
  state.boat.x = state.world.harbor.x;
  state.boat.y = state.world.harbor.y;
  state.boat.speed = 0;
  step(state, 0.05);
  const expected = 1000 + Math.round(1200 + state.boat.hull * 8 + state.boat.fuel * 4 - state.totalElapsed * 2);
  assert.equal(state.score, expected);
});

test("finished operations reject new held controls but accept safe releases", () => {
  const state = createStarted();
  state.phase = "finished";
  state.won = true;
  assert.equal(setControl(state, "forward", true), false);
  state.controls.pump = true;
  assert.equal(setControl(state, "pump", false), true);
  assert.equal(state.controls.pump, false);
});

test("all ordinary mobile-frame mission variants remain collision-free and completable", () => {
  for (const level of [1, 2, 3]) {
    for (const dt of [0.05, 0.11]) {
      for (const error of [-9, 9]) {
        const state = createStarted({level, boatId: level === 3 ? "kasatka" : "strizh"});
        const events = [];
        for (const survivor of state.world.survivors) {
          events.push(...ordinaryApproach(state, survivor, error, dt));
          setControl(state, "rescue", true);
          events.push(...run(state, 3, dt));
          assert.equal(survivor.rescued, true, `${level}/${dt}/${error}/${survivor.id}`);
        }
        events.push(...ordinaryApproach(state, state.world.harbor, error, dt));
        assert.equal(state.won, true, `${level}/${dt}/${error}`);
        assert.equal(events.some(event => event.type === "collision"), false, `${level}/${dt}/${error}`);
      }
    }
  }
});

test("complete risk missions clear every advertised gate without collisions", () => {
  for (const level of [2, 3]) {
    const state = createStarted({
      level,
      boatId: level === 3 ? "kasatka" : "strizh",
      upgrades: {"coast-brake": true, "mini-armor": true, "high-flow-pump": true},
    });
    assert.equal(command(state, "risk-route-toggle").ok, true);
    const events = [];
    for (const survivor of state.world.survivors) {
      events.push(...riskApproach(state, survivor));
      setControl(state, "rescue", true);
      events.push(...run(state, 3, 0.08));
      assert.equal(survivor.rescued, true);
    }
    events.push(...riskApproach(state, state.world.harbor));
    assert.equal(state.won, true);
    assert.equal(events.some(event => event.type === "collision"), false);
    assert.equal(state.riskRoute.cleanGates, level === 2 ? 2 : 4);
    assert.equal(state.riskRoute.creditBonus, (level === 2 ? 2 : 4) * CONFIG.riskGateCreditBonus);
    assert.ok(state.progression.rewardCredits >= state.riskRoute.creditBonus);
  }
});

test("risk state survives serialization without duplicating cleared rewards", () => {
  const state = createStarted({level: 3});
  command(state, "risk-route-toggle");
  command(state, "sonar");
  const [entry, exit] = getRoutePlan(state, "survivor-a");
  for (const point of [entry, exit]) {
    state.boat.x = point.x;
    state.boat.y = point.y;
    step(state, 0.01);
  }
  const restored = deserialize(serialize(state));
  assert.deepEqual(restored.riskRoute.clearedKeys, state.riskRoute.clearedKeys);
  assert.equal(restored.riskRoute.creditBonus, CONFIG.riskGateCreditBonus);
  assert.equal(getView(restored).riskRoute.cleanGates, 1);
});

test("deterministic control fuzz keeps every active mechanic finite and serializable", () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    let randomState = seed >>> 0;
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    const level = 1 + seed % 3;
    const state = createStarted({level, boatId: level === 3 && seed % 2 ? "kasatka" : "strizh"});
    if (level >= 2 && seed % 2) command(state, "risk-route-toggle");
    for (let index = 0; index < 900 && state.phase === "playing"; index += 1) {
      if (index % 41 === 0) {
        state.sonar.cooldown = 0;
        command(state, "sonar");
      }
      if (index % 17 === 0) setControl(state, "forward", random() > 0.34);
      if (index % 23 === 0) setControl(state, "reverse", random() > 0.82);
      if (index % 13 === 0) setControl(state, "left", random() > 0.72);
      if (index % 19 === 0) setControl(state, "right", random() > 0.72);
      if (index % 29 === 0) setControl(state, "pump", random() > 0.65);
      step(state, 0.025 + random() * 0.2);
      for (const value of [
        state.boat.x, state.boat.y, state.boat.heading, state.boat.speed, state.boat.hull,
        state.boat.water, state.boat.leak, state.boat.fuel, state.boat.engineTemp, state.score,
      ]) assert.ok(Number.isFinite(value), `seed ${seed}, step ${index}, value ${value}`);
      assert.ok(state.boat.x >= state.world.bounds.minX - 0.01 && state.boat.x <= state.world.bounds.maxX + 0.01);
      assert.ok(state.boat.y >= state.world.bounds.minY - 0.01 && state.boat.y <= state.world.bounds.maxY + 0.01);
    }
    const restored = deserialize(serialize(state));
    assert.equal(restored.phase, state.phase);
    assert.equal(restored.score, state.score);
    assert.equal(getView(restored).riskRoute.creditBonus, getView(state).riskRoute.creditBonus);
  }
});

test("release UI, network recovery, speech and bundled audio expose the audited mechanics", async () => {
  const [html, app, gameplay, audio, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/gameplay-v6.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/audio-engine-v9.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="routeModeButton"/);
  assert.match(html, /game-core-v13\.js\?v=16\.0/);
  assert.match(html, /Чистый проход без столкновения/);
  assert.match(styles, /grid-area: route/);
  assert.match(app, /bestByLevel/);
  assert.match(app, /network-error/);
  assert.match(app, /hullRepair/);
  assert.match(app, /utterance\.onend = resumeGameAudio/);
  assert.doesNotMatch(app, /render\(Boolean\(events\.length\)\)/);
  assert.match(gameplay, /Помощник откачивает — нажми для усиления/);
  assert.match(audio, /await this\.localPreloadPromise/);
  assert.match(audio, /risk-gate-cleared/);
});
