import test from "node:test";
import assert from "node:assert/strict";

import {VESSEL_FEEDBACK_POLICY_SYSTEMS} from "../public/src/vessel/systems/vessel-feedback-policy-system.js?v=1";

const before = VESSEL_FEEDBACK_POLICY_SYSTEMS.find(system => system.phase === "before-step");
const feedback = VESSEL_FEEDBACK_POLICY_SYSTEMS.find(system => system.phase === "after-step");

function fixture() {
  const boat = {id: 4, crew: [0], driver: null, sunk: false, pumpActive: false};
  const entry = {
    boat,
    definition: {subsystemAuthority: {flooding: "vessel-zonal-v2"}},
    instance: {
      occupants: {0: {deckId: "engine-room"}},
      modules: {"bilge-pump": {health: 0, enabled: false, active: false}},
    },
  };
  const world = {
    time: 10,
    inputs: [{pump: true}],
    operationInputs: [{pump: true}],
    freeActivities: {inputs: [{pump: true}]},
    events: [],
  };
  return {world, entry};
}

function denial() {
  return {type: "vessel-pump-disabled", boatId: 4, text: "Трюмная помпа повреждена."};
}

test("failed modular pump feedback is emitted once per continuous request", () => {
  const {world, entry} = fixture();

  world.events.push(denial(), denial());
  feedback.run({world, nativeVessels: [entry], eventStart: 0});
  assert.equal(world.events.filter(event => event.type === "vessel-pump-disabled").length, 1, "duplicate failures in one tick collapse to one reason");
  assert.match(world.events[0].text, /Насос включить невозможно/i);
  assert.equal(world.events[0].reason, "damaged");

  const nextStart = world.events.length;
  world.events.push(denial());
  feedback.run({world, nativeVessels: [entry], eventStart: nextStart});
  assert.equal(world.events.filter(event => event.type === "vessel-pump-disabled").length, 1, "holding the same failed pump request must stay silent after the first warning");

  world.inputs[0].pump = false;
  world.operationInputs[0].pump = false;
  world.freeActivities.inputs[0].pump = false;
  feedback.run({world, nativeVessels: [entry], eventStart: world.events.length});

  world.inputs[0].pump = true;
  world.operationInputs[0].pump = true;
  world.freeActivities.inputs[0].pump = true;
  const retryStart = world.events.length;
  world.events.push(denial());
  feedback.run({world, nativeVessels: [entry], eventStart: retryStart});
  assert.equal(world.events.filter(event => event.type === "vessel-pump-disabled").length, 2, "release plus a deliberate retry may explain the failure once again");
});

test("a repaired pump rearms failure feedback even without releasing the request", () => {
  const {world, entry} = fixture();
  world.events.push(denial());
  feedback.run({world, nativeVessels: [entry], eventStart: 0});
  assert.equal(world.events.length, 1);

  entry.instance.modules["bilge-pump"].health = 60;
  entry.instance.modules["bilge-pump"].enabled = true;
  feedback.run({world, nativeVessels: [entry], eventStart: world.events.length});

  entry.instance.modules["bilge-pump"].health = 0;
  entry.instance.modules["bilge-pump"].enabled = false;
  const start = world.events.length;
  world.events.push(denial());
  feedback.run({world, nativeVessels: [entry], eventStart: start});
  assert.equal(world.events.filter(event => event.type === "vessel-pump-disabled").length, 2, "a new breakage is a new state transition and deserves one warning");
});

test("modular pump start is announced only after the authoritative module becomes active", () => {
  const {world, entry} = fixture();
  const pump = entry.instance.modules["bilge-pump"];
  pump.health = 80;
  pump.enabled = true;

  before.run({world, nativeVessels: [entry], eventStart: 0});
  pump.active = true;
  entry.boat.pumpActive = true;
  feedback.run({world, nativeVessels: [entry], eventStart: 0});

  let starts = world.events.filter(event => event.type === "vessel-pump-start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].text, "Насос включён.");
  assert.equal(starts[0].boatId, 4);

  const nextStart = world.events.length;
  before.run({world, nativeVessels: [entry], eventStart: nextStart});
  feedback.run({world, nativeVessels: [entry], eventStart: nextStart});
  starts = world.events.filter(event => event.type === "vessel-pump-start");
  assert.equal(starts.length, 1, "holding an already active pump cannot repeat the start announcement");
});

test("repairing pump denial explains that the pump is temporarily unavailable", () => {
  const {world, entry} = fixture();
  const pump = entry.instance.modules["bilge-pump"];
  pump.health = 55;
  pump.enabled = false;
  pump.repairActive = true;
  world.events.push(denial());

  feedback.run({world, nativeVessels: [entry], eventStart: 0});
  const event = world.events.find(candidate => candidate.type === "vessel-pump-disabled");
  assert.ok(event);
  assert.equal(event.reason, "repairing");
  assert.match(event.text, /сейчас ремонтируется/i);
});
