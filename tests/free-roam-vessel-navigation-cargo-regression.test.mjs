import test from "node:test";
import assert from "node:assert/strict";

import {
  createFreeWorld,
  setPlayerInput,
} from "../public/src/free-roam-core-v7.js";
import {
  createFreeWorld as createCurrentFreeWorld,
  stepFreeWorld as stepCurrentFreeWorld,
} from "../public/src/free-roam-core-v8.js";
import {scenarioTarget} from "../public/src/free-roam-scenario.js";
import {merchantBoatForPlayer} from "../public/src/free-roam-shop.js";
import {isBoatDockPosition} from "../public/src/free-roam-cargo-rules.js";
import {VESSEL_DECK_INPUT_BRIDGE_SYSTEMS} from "../public/src/vessel/systems/vessel-deck-input-bridge-system.js";
import {VESSEL_MERCHANT_RECOVERY_SYSTEMS} from "../public/src/vessel/systems/vessel-merchant-recovery-system.js";
import {VESSEL_OWNERSHIP_SYSTEMS} from "../public/src/vessel/systems/vessel-ownership-system.js";
import {listVesselNavigationTargets} from "../public/src/vessel/vessel-navigation.js";
import {
  relativeVesselPan,
  vesselUsesCustomEngineAudio,
} from "../public/src/vessel/vessel-audio-policy.js";
import {applyServerFreeInput} from "../src/free-roam-server.js";

test("generic vessel navigation ids survive the shared input pipeline", () => {
  const world = createFreeWorld();
  setPlayerInput(world, 0, {navigationTargetId: "vessel:42"});
  assert.equal(world.freeActivities.inputs[0].navigationTargetId, "vessel:42");
});

test("selected vessel navigation id survives real server ingress and becomes the scenario target", () => {
  const world = createCurrentFreeWorld();
  const vessel = listVesselNavigationTargets(world, 0)[0];
  assert.ok(vessel, "the live world must expose at least one navigable vessel");

  const serverRoom = {
    world,
    lastTickAt: 1_000,
    sequence: 0,
    inputSequence: [0, 0],
    receivedInputs: [{}, {}],
    pendingPulses: [{}, {}],
  };

  assert.equal(applyServerFreeInput(serverRoom, "captain", {navigationTargetId: vessel.id}, 1), true);
  assert.equal(serverRoom.receivedInputs[0].navigationTargetId, vessel.id, "server normalization must not rewrite vessel:<id> to objective");
  assert.equal(world.freeActivities.inputs[0].navigationTargetId, vessel.id, "the selected vessel id must reach the shared scenario input");

  stepCurrentFreeWorld(world, 0.05);
  const target = scenarioTarget(world, 0);
  assert.equal(target?.kind, "vessel");
  assert.equal(target?.boatId, vessel.boatId);
  assert.equal(target?.id, vessel.id);
  assert.equal(target?.x, world.boats[vessel.boatId].x);
  assert.equal(target?.y, world.boats[vessel.boatId].y);
});

test("native merchant recovery becomes a real serviceable vessel and survives stale flooding state", () => {
  const before = VESSEL_MERCHANT_RECOVERY_SYSTEMS.find(system => system.phase === "before-step");
  const after = VESSEL_MERCHANT_RECOVERY_SYSTEMS.find(system => system.phase === "after-step");
  assert.ok(before && after);

  const testBoat = {
    id: 3,
    label: "испытательный катер «Пятьдесят»",
    x: 210,
    y: 78,
    hull: 105,
    hullMax: 180,
    sunk: false,
    owner: 0,
    repairPatches: 10,
  };
  const boat = {
    id: 4,
    label: "средний двухместный корабль",
    x: 276.53,
    y: 121.8,
    collisionRadius: 13.5,
    hull: 0,
    hullMax: 220,
    sunk: false,
    owner: 0,
    repairPatches: 0,
    emergencyActive: true,
    emergencyRemaining: 45,
    emergencyWarned15: false,
    emergencyWarned5: false,
    speed: 0,
    throttle: 0,
    rudder: 0,
    engineStalled: true,
  };
  const engine = {health: 35, enabled: false, repairActive: false};
  const instance = {
    modules: {engine},
    interior: {
      waterBridge: {
        floodStalled: true,
        floodDisabledModules: {},
      },
    },
  };
  const world = {
    players: [{activeBoat: null, lastBoatId: 3}],
    boats: [null, null, null, testBoat, boat],
    events: [
      {type: "wreck-recovery-complete", sourcePlayer: 0, boatId: 4, text: "Аварийный подъём завершён."},
      {type: "flood-emergency-start", boatId: 4, cause: "wrecked", text: "Авария."},
    ],
  };
  const entry = {boat, instance};

  after.run({world, nativeVessels: [entry], eventStart: 0});

  assert.equal(boat.hull, 44, "20% merchant recovery for a 220 hull vessel must survive the vessel authority handoff");
  assert.equal(boat.sunk, false);
  assert.equal(boat.emergencyActive, false, "the stale zero-hull snapshot must not start a new loss countdown");
  assert.equal(boat.emergencyRemaining, 0);
  assert.equal(world.events.some(event => event.type === "flood-emergency-start" && event.boatId === 4), false, "the false emergency must not be announced");
  assert.equal(isBoatDockPosition(boat), true, "a recovered architecture vessel advertised as being at the pier must actually be inside the merchant service dock");
  assert.equal(world.players[0].lastBoatId, 4, "recovery must make the recovered vessel the player's merchant service target");
  assert.equal(engine.enabled, true, "an operable recovered engine must be stalled, not permanently disabled behind a repair plate");
  assert.equal(merchantBoatForPlayer(world, 0, {docked: true, sunk: false})?.id, 4, "merchant repair plates must target the recovered medium vessel instead of a stale test boat");

  // Existing saved worlds from the previous recovery contract can already have
  // floodStalled + positive engine health + enabled=false with no new recovery
  // event. The before-step reconciliation must unlock that state too.
  engine.enabled = false;
  world.events = [];
  before.run({world, nativeVessels: [entry], eventStart: 0});
  assert.equal(engine.enabled, true, "a previously recovered saved world must escape the old permanent engine-disabled softlock");
});

test("active architecture vessel becomes the shared last service vessel", () => {
  const ownership = VESSEL_OWNERSHIP_SYSTEMS.find(system => system.phase === "after-step");
  assert.ok(ownership);
  const boat = {id: 4, vesselInstanceId: "medium:4"};
  const world = {
    players: [{activeBoat: 4, lastBoatId: 3}],
    boats: [null, null, null, null, boat],
    events: [],
  };
  ownership.run({world, nativeVessels: [{boat}], eventStart: 0});
  assert.equal(world.players[0].lastBoatId, 4, "walking or sitting aboard a native vessel must update the same service affinity used by the merchant");
});

test("cargo on an old owned boat does not redirect a swimmer to the dock", () => {
  const world = createFreeWorld();
  const player = world.players[0];
  const oldBoat = world.boats[0];
  const pump = world.freeActivities.crates.find(crate => crate.id === "crate-pump");
  const fuel = world.freeActivities.crates.find(crate => crate.id === "crate-fuel");

  assert.ok(player && oldBoat && pump && fuel);
  world.freeScenario.phase = "salvage";
  world.freeScenario.navigationModes[0] = "objective";
  world.freeScenario.lockedTargetIds[0] = fuel.id;

  pump.state = "stowed";
  pump.carriedBy = null;
  pump.stowedBoat = oldBoat.id;
  oldBoat.cargo = [pump.id];

  fuel.state = "world";
  fuel.carriedBy = null;
  fuel.stowedBoat = null;

  player.mode = "swim";
  player.activeBoat = null;
  player.combat.carriedCrate = null;

  const onFootTarget = scenarioTarget(world, 0);
  assert.equal(onFootTarget?.id, fuel.id, "old boat cargo must not hijack the current shore objective");

  player.mode = "boat";
  player.activeBoat = oldBoat.id;
  const aboardTarget = scenarioTarget(world, 0);
  assert.equal(aboardTarget?.kind, "dock", "cargo on the current active boat should still route to unloading");
});

test("cargo action from an occupied vessel station does not also leave the station", () => {
  const before = VESSEL_DECK_INPUT_BRIDGE_SYSTEMS.find(system => system.phase === "before-input");
  const after = VESSEL_DECK_INPUT_BRIDGE_SYSTEMS.find(system => system.phase === "after-input");
  assert.ok(before && after);

  const station = {
    id: "test-helm-seat",
    kind: "station",
    resourceId: "test-helm-control",
    stationRole: "helm",
    controlsVessel: true,
  };
  const entry = {
    boat: {id: 3},
    definition: {
      deckArchitecture: {enabled: true},
      decks: [{id: "test-deck", objects: [station]}],
    },
    instance: {
      occupants: {0: {deckId: "test-deck", x: 0, y: 0}},
      interior: {claims: {"test-helm-control": 0}},
    },
  };
  const world = {
    players: [{activeBoat: 3, x: 0, y: 0, combat: {carriedCrate: null}}],
    inputs: [{action: false}],
    operationInputs: [{action: false}],
    previousInputs: [{action: false}],
    operationPreviousInputs: [{action: false}],
    freeActivities: {
      crates: [{id: "nearby-cargo", state: "world", x: 2, y: 0}],
      inputs: [{action: false}],
      previousInputs: [{action: false}],
    },
  };
  const input = {action: true, attack: false, pump: false, repair: false, guide: false};

  before.run({world, nativeVessels: [entry], playerIndex: 0, input});
  assert.equal(input.action, false, "deck interaction must not receive leave-station when cargo owns this press");
  after.run({world, nativeVessels: [entry], playerIndex: 0, input});
  assert.equal(world.freeActivities.inputs[0].action, true, "legacy cargo system must still receive the stow action");

  world.freeActivities.crates[0].x = 40;
  const leaveInput = {action: true, attack: false, pump: false, repair: false, guide: false};
  before.run({world, nativeVessels: [entry], playerIndex: 0, input: leaveInput});
  assert.equal(leaveInput.action, true, "without cargo, the same action remains available to leave the station");
});

test("foot and swim vessel audio stays world-anchored when the listener turns", () => {
  const east = {x: 10, y: 0};
  const west = {x: -10, y: 0};

  assert.equal(relativeVesselPan({x: 0, y: 0, heading: 0, mode: "foot"}, east), 1);
  assert.equal(relativeVesselPan({x: 0, y: 0, heading: 180, mode: "foot"}, east), 1, "turning in place must not throw the same boat into the opposite ear");
  assert.equal(relativeVesselPan({x: 0, y: 0, heading: 90, mode: "swim"}, east), 1, "swimming keeps the same world-anchored navigation convention");
  assert.equal(relativeVesselPan({x: 0, y: 0, heading: -90, mode: "foot"}, west), -1);

  const beforeCrossing = relativeVesselPan({x: -4, y: 0, heading: 180, mode: "foot"}, {x: 0, y: 0});
  const afterCrossing = relativeVesselPan({x: 4, y: 0, heading: 180, mode: "foot"}, {x: 0, y: 0});
  assert.ok(beforeCrossing > 0 && afterCrossing < 0, "the ear changes only after the listener actually crosses the vessel in world space");

  assert.equal(vesselUsesCustomEngineAudio({audioProfile: "standard"}), false);
  assert.equal(vesselUsesCustomEngineAudio({audioProfile: "stress-50-engine-v2"}), true);
  assert.equal(vesselUsesCustomEngineAudio({audioProfile: "medium-crew-v1"}), true);
  assert.equal(vesselUsesCustomEngineAudio({audioProfile: "dual-turret-heavy"}), true);
});
