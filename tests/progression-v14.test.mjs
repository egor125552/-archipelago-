import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {
  CONFIG,
  collisionSeverity,
  command,
  createGame,
  getView,
  setControl,
  startGame,
  step,
} from "../public/src/game-core-v12.js";
import {
  createDefaultProfile,
  loadProfile,
  purchaseUpgrade,
  recordOperation,
  runLoadout,
  saveProfile,
  selectBoat,
} from "../public/src/progression.js";

const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
const bearing = (from, to) => Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function run(state, seconds, dt = 0.05) {
  const events = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) events.push(...step(state, dt));
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

function directApproach(state, target, error = 8, seconds = 120) {
  state.sonar.cooldown = 0;
  command(state, "sonar");
  state.boat.heading = wrap(bearing(state.boat, target) + error);
  setControl(state, "forward", true);
  const events = [];
  for (let elapsed = 0; elapsed < seconds && state.phase === "playing"; elapsed += 0.05) {
    events.push(...step(state, 0.05));
    const view = getView(state);
    if (target.id !== "harbor" && view.navigation.rescueMode) return events;
    if (target.id === "harbor" && state.won) return events;
  }
  return events;
}

test("level one completion opens level two, selects it and funds one shop choice", () => {
  const initial = createDefaultProfile();
  const completed = recordOperation(initial, {level: 1, won: true, reward: 900, score: 3301});
  assert.equal(completed.unlockedLevel, 2);
  assert.equal(completed.selectedLevel, 2);
  assert.equal(completed.credits, 900);
  assert.equal(completed.bestScore, 3301);

  const purchase = purchaseUpgrade(completed, "coast-brake");
  assert.equal(purchase.ok, true);
  assert.equal(purchase.profile.credits, 250);
  assert.ok(purchase.profile.ownedUpgrades.includes("coast-brake"));
});

test("profile progress survives a storage round trip", () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const completed = recordOperation(createDefaultProfile(), {level: 1, won: true, reward: 900, score: 3301});
  saveProfile(completed, storage);
  const restored = loadProfile(storage);
  assert.equal(restored.unlockedLevel, 2);
  assert.equal(restored.credits, 900);
  assert.equal(restored.bestScore, 3301);
});

test("Kasatka remains locked until level three and then becomes selectable", () => {
  const initial = createDefaultProfile();
  assert.equal(selectBoat(initial, "kasatka").selectedBoat, "strizh");
  const levelTwo = recordOperation(initial, {level: 1, won: true, reward: 900, score: 3000});
  const levelThree = recordOperation(levelTwo, {level: 2, won: true, reward: 1000, score: 3200});
  assert.equal(levelThree.unlockedLevel, 3);
  assert.equal(selectBoat(levelThree, "kasatka").selectedBoat, "kasatka");
});

test("high-speed collision damage grows nonlinearly and is severe", () => {
  assert.ok(collisionSeverity(18) > collisionSeverity(9) * 2.8);
  const state = createGame({mode: "solo", progression: {level: 2, boatId: "strizh", upgrades: {}}});
  startGame(state);
  state.training.safetyEnabled = false;
  const wreck = state.world.hazards.find(item => item.id === "wreck-gate");
  state.boat.x = wreck.x;
  state.boat.y = wreck.y - wreck.radius - CONFIG.collisionMargin - 0.3;
  state.boat.heading = 0;
  state.boat.speed = 18;
  const events = step(state, 0.05);
  const collision = events.find(event => event.type === "collision");
  assert.ok(collision);
  assert.ok(collision.damage > 50, `damage was ${collision.damage}`);
  assert.ok(state.boat.hull < 50, `hull was ${state.boat.hull}`);
  assert.match(state.message, /потеря корпуса/i);
});

test("mini armor absorbs the first part of a violent impact", () => {
  const state = createGame({
    mode: "solo",
    progression: {level: 2, boatId: "strizh", upgrades: {"mini-armor": true}},
  });
  startGame(state);
  state.training.safetyEnabled = false;
  const wreck = state.world.hazards.find(item => item.id === "wreck-gate");
  state.boat.x = wreck.x;
  state.boat.y = wreck.y - wreck.radius - CONFIG.collisionMargin - 0.3;
  state.boat.heading = 0;
  state.boat.speed = 18;
  const collision = step(state, 0.05).find(event => event.type === "collision");
  assert.ok(collision.absorbed > 20);
  assert.ok(collision.damage < 40);
  assert.ok(state.boat.hull > 60);
  assert.ok(state.boat.armor < CONFIG.miniArmor);
});

test("purchased coast brake stops exactly within five seconds after release", () => {
  const state = createGame({
    mode: "solo",
    progression: {level: 2, boatId: "strizh", upgrades: {"coast-brake": true}},
  });
  startGame(state);
  state.boat.speed = 10;
  setControl(state, "forward", true);
  setControl(state, "forward", false);
  run(state, 4.7);
  assert.ok(state.boat.speed > 0.1, `stopped too early at ${state.boat.speed}`);
  const events = run(state, 0.4);
  assert.equal(state.boat.speed, 0);
  assert.ok(events.some(event => event.type === "auto-stop"));
});

test("level three Kasatka has a stable protected hull and distinct model", () => {
  const state = createGame({mode: "solo", progression: {level: 3, boatId: "kasatka", upgrades: {}}});
  startGame(state);
  const view = getView(state);
  assert.equal(view.boat.modelId, "kasatka");
  assert.match(view.boat.modelName, /Касатка/);
  assert.equal(state.boat.collisionDamageMultiplier, 0.72);
  assert.equal(state.boat.engineHeatMultiplier, 0.76);
});

test("an unlocked Kasatka can be used for replaying an earlier operation", () => {
  const state = createGame({mode: "solo", progression: {level: 1, boatId: "kasatka", upgrades: {}}});
  assert.equal(getView(state).boat.modelId, "kasatka");
});

test("all advanced-level direct center lines stay physically open", () => {
  for (const level of [2, 3]) {
    const state = createGame({mode: "solo", progression: {level, boatId: level === 3 ? "kasatka" : "strizh", upgrades: {}}});
    const legs = [
      [state.world.harbor, state.world.survivors[0]],
      [state.world.survivors[0], state.world.survivors[1]],
      [state.world.survivors[1], state.world.harbor],
    ];
    for (const [from, to] of legs) {
      for (const hazard of state.world.hazards) {
        const clearance = segmentClearance(from, to, hazard);
        assert.ok(clearance > 1, `level ${level} ${from.id}->${to.id} clearance ${clearance} at ${hazard.id}`);
      }
    }
  }
});

test("advanced operations remain completable by center, gas and rope", () => {
  for (const level of [2, 3]) {
    const state = createGame({
      mode: "solo",
      progression: {level, boatId: level === 3 ? "kasatka" : "strizh", upgrades: {"mini-armor": true}},
    });
    startGame(state);
    state.training.safetyEnabled = false;
    const events = [];
    for (const survivor of state.world.survivors) {
      events.push(...directApproach(state, survivor, survivor.id === "survivor-a" ? -8 : 8));
      assert.ok(distance(state.boat, survivor) <= CONFIG.rescueRadius);
      setControl(state, "rescue", true);
      events.push(...run(state, 3));
      assert.equal(survivor.rescued, true);
    }
    events.push(...directApproach(state, state.world.harbor, -8));
    assert.equal(state.won, true);
    assert.equal(events.some(event => event.type === "collision"), false);
    assert.ok(state.progression.rewardCredits >= 250);
  }
});

test("release UI exposes levels, shop, armor and the distinct Kasatka engine", async () => {
  const [html, app, audio] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/audio-engine-v10.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Магазин спасслужбы/);
  assert.match(html, /id="armor"/);
  assert.match(html, /game-core-v12\.js\?v=15\.0/);
  assert.match(app, /loadProfile/);
  assert.match(app, /purchaseUpgrade/);
  assert.match(audio, /modelId !== "kasatka"/);
});

test("owned shop items are carried into a run loadout", () => {
  const profile = recordOperation(createDefaultProfile(), {level: 1, won: true, reward: 2000, score: 3100});
  const armor = purchaseUpgrade(profile, "mini-armor").profile;
  const brake = purchaseUpgrade(armor, "coast-brake").profile;
  const loadout = runLoadout(brake);
  assert.equal(loadout.level, 2);
  assert.equal(loadout.upgrades["mini-armor"], true);
  assert.equal(loadout.upgrades["coast-brake"], true);
});
