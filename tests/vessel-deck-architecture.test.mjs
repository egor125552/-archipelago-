import test from "node:test";
import assert from "node:assert/strict";

import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {renderVesselEntityTemplate} from "../public/src/vessel/vessel-presentation.js";
import {setVesselOccupantPosition, syncWalkableVesselOccupants} from "../public/src/vessel/vessel-interior.js";
import {
  adjustVesselZoneWater,
  advanceVesselDeckRuntime,
  applyVesselDeckEntityDamage,
  beginVesselTraversal,
  connectionPassable,
  listVesselDeckActions,
  performVesselDeckAction,
  resolveVesselAcousticPath,
  safeReconnectPosition,
  setVesselConnectionState,
  tryMoveVesselOccupant,
  vesselDeckPersistentState,
  vesselInertiaResponse,
  vesselOccupantWaterState,
} from "../public/src/vessel/vessel-deck-runtime.js";
import {vesselModuleEffectiveness} from "../public/src/vessel/vessel-modules.js";
import {vesselNetworkSnapshot} from "../public/src/vessel/vessel-network.js";

function installToggleRule(registry) {
  registry.registerDeckRuleType({
    id: "test-toggle-rule",
    persistentFields: ["on"],
    networkStateFields: ["on"],
    createState: () => ({on: false, privateCounter: 0}),
    actions: () => [{id: "toggle", label: "переключить"}],
    performAction: ({action, state}) => {
      if (action !== "toggle") return {handled: false};
      state.on = !state.on;
      state.privateCounter += 1;
      return {handled: true, on: state.on};
    },
  });
}

function fixture(registry, id = "deck-fixture") {
  installToggleRule(registry);
  return registry.registerVesselType({
    id,
    label: "Тестовое судно",
    capabilities: {walkableInterior: true, replicates: true},
    deckArchitecture: {
      boarding: {mode: "deck-entry", points: [{id: "entry", deckId: "main", position: [-4, 0]}]},
      control: {mode: "stations"},
      reconnect: {mode: "last-valid-or-safe"},
      acoustics: {mode: "automatic", transitionMs: 200},
      playerInertia: {mode: "stable"},
      cargoInertia: {mode: "physical", scale: 1, fallThreshold: 2, overboardThreshold: 4},
      sinking: {mode: "emergency-phase", emergencyDuration: 5, floodRate: 10, geometryTilt: true},
    },
    decks: [
      {
        id: "main", label: "главная палуба", presentation: {forms: {into: "на главную палубу"}},
        shape: {outer: [[-5,-5],[5,-5],[5,5],[-5,5]], holes: [[[-1,-1],[1,-1],[1,1],[-1,1]]]},
        zones: [{id: "main-zone", label: "главная палуба", shape: {outer: [[-5,-5],[5,-5],[5,5],[-5,5]], holes: [[[-1,-1],[1,-1],[1,1],[-1,1]]]}, water: {enabled: true, maxDepth: 2, swimDepth: 1, fullDamagePerSecond: 3}, announcement: {mode: "first-entry"}}],
        objects: [
          {id: "helm", kind: "station", label: "штурвал", position: [-3,0], zoneId: "main-zone", interactionRange: 2, presentation: {forms: {at: "у штурвала"}}},
          {id: "crate", kind: "item", label: "ящик", position: [3,0], zoneId: "main-zone", buoyancy: "float", rules: [{id: "toggleable", type: "test-toggle-rule"}]},
        ],
        landmarks: [{id: "bow", label: "нос", position: [0,4], zoneId: "main-zone"}],
        connections: [{id: "down", kind: "hatch", label: "люк вниз", toDeckId: "lower", reverseId: "up", from: [0,-4], initialState: "closed", damageable: true, health: 50, traversal: {mode: "timed", duration: 1}, water: {watertight: true, flowRate: 20}, acoustics: {openTransmission: 0.9, closedTransmission: 0.1}}],
      },
      {
        id: "lower", label: "нижняя палуба", level: -1,
        shape: {outer: [[-4,-4],[4,-4],[4,4],[-4,4]]},
        zones: [{id: "engine-room", label: "машинное отделение", shape: {outer: [[-4,-4],[4,-4],[4,4],[-4,4]]}, water: {enabled: true, maxDepth: 2}}],
        objects: [{id: "pump", kind: "object", label: "насос", position: [2,2], zoneId: "engine-room"}],
        connections: [{id: "up", kind: "hatch", label: "люк наверх", toDeckId: "main", reverseId: "down", from: [0,3], initialState: "closed", traversal: {mode: "geometry", speed: 2}, water: {watertight: true, flowRate: 20}, acoustics: {openTransmission: 0.9, closedTransmission: 0.1}}],
      },
    ],
  });
}

test("strict compiler rejects broken geometry, disconnected decks and invalid policies", () => {
  const registry = createVesselRegistry();
  assert.throws(() => registry.registerVesselType({id: "cross", label: "bad", capabilities: {walkableInterior: true}, decks: [{id: "main", label: "deck", shape: {outer: [[0,0],[4,4],[0,4],[4,0]]}}]}), /self-intersects|zero area/);
  assert.throws(() => registry.registerVesselType({id: "split", label: "bad", capabilities: {walkableInterior: true}, decks: [{id: "a", label: "A", shape: {outer: [[0,0],[2,0],[2,2],[0,2]]}}, {id: "b", label: "B", shape: {outer: [[0,0],[2,0],[2,2],[0,2]]}}]}), /unreachable decks/);
  assert.throws(() => registry.registerVesselType({id: "bad-item", label: "bad", capabilities: {walkableInterior: true}, decks: [{id: "main", label: "deck", shape: {outer: [[0,0],[4,0],[4,4],[0,4]]}, objects: [{id: "box", label: "box", position: [2,2], buoyancy: "teleport"}]}]}), /buoyancy/);
});

test("old boats stay valid with deck architecture disabled", () => {
  const registry = createVesselRegistry();
  const definition = registry.registerVesselType({id: "old-boat", label: "старый катер", capabilities: {replicates: true}});
  assert.equal(definition.deckArchitecture.enabled, false);
  assert.deepEqual(registry.createInstance(definition.id, {instanceId: "old-boat:i1"}).occupants, {});
});

test("walking has safe edges and heading stays local to the moving vessel", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "movement-fixture");
  const instance = registry.createInstance(definition.id, {instanceId: "movement-fixture:i1"});
  setVesselOccupantPosition(definition, instance, 0, {deckId: "main", x: -4, y: 0, heading: 35});
  assert.equal(tryMoveVesselOccupant(definition, instance, 0, {x: -3, y: 0}).reason, "deck-edge");
  const world = {players: [{activeBoat: 0}]};
  syncWalkableVesselOccupants(world, definition, instance, {id: 0, x: 10, y: 20, heading: 90});
  assert.equal(Math.round(world.players[0].heading), 125);
});

test("reciprocal hatch has one physical state; timed traversal and destruction are server-stateful", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "hatch-fixture");
  const instance = registry.createInstance(definition.id, {instanceId: "hatch-fixture:i1"});
  setVesselOccupantPosition(definition, instance, 0, {deckId: "main", x: 0, y: -3.8});
  setVesselConnectionState(definition, instance, "down", "open");
  assert.equal(instance.interior.connections.up.state, "open");
  assert.equal(beginVesselTraversal(definition, instance, 0, "down").completed, false);
  advanceVesselDeckRuntime(definition, instance, 1.1);
  assert.equal(instance.occupants[0].deckId, "lower");
  setVesselConnectionState(definition, instance, "down", "closed");
  applyVesselDeckEntityDamage(definition, instance, {kind: "connection", id: "down", damage: 100});
  assert.equal(connectionPassable(definition, instance, "down"), true);
  assert.equal(instance.interior.connections.up.state, "destroyed");
});

test("shared interactions enforce distance, multiplayer claims and custom rule actions", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "interaction-fixture");
  const instance = registry.createInstance(definition.id, {instanceId: "interaction-fixture:i1"});
  setVesselOccupantPosition(definition, instance, 0, {deckId: "main", x: -3, y: 0});
  setVesselOccupantPosition(definition, instance, 1, {deckId: "main", x: -3, y: 0});
  assert.deepEqual(listVesselDeckActions(registry, definition, instance, 0, {kind: "object", id: "helm"}).map(a => a.id), ["occupy"]);
  performVesselDeckAction(registry, definition, instance, 0, {kind: "object", id: "helm"}, "occupy");
  assert.deepEqual(listVesselDeckActions(registry, definition, instance, 1, {kind: "object", id: "helm"}), []);
  setVesselOccupantPosition(definition, instance, 0, {deckId: "main", x: 3, y: 0});
  assert.equal(performVesselDeckAction(registry, definition, instance, 0, {kind: "object", id: "crate"}, "toggle").on, true);
});

test("watertight closed hatch blocks water; open hatch propagates it and full flooding affects occupant", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "water-fixture");
  const instance = registry.createInstance(definition.id, {instanceId: "water-fixture:i1"});
  adjustVesselZoneWater(definition, instance, "main-zone", 100);
  setVesselOccupantPosition(definition, instance, 0, {deckId: "main", x: -2, y: 0});
  assert.equal(vesselOccupantWaterState(definition, instance, 0).mode, "full");
  advanceVesselDeckRuntime(definition, instance, 1);
  assert.equal(instance.zones["engine-room"].flooding, 0);
  setVesselConnectionState(definition, instance, "down", "open");
  advanceVesselDeckRuntime(definition, instance, 1);
  assert.ok(instance.zones["engine-room"].flooding > 0);
});

test("acoustics react to live hatch state and preserve smooth transition metadata", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "acoustic-fixture");
  const instance = registry.createInstance(definition.id, {instanceId: "acoustic-fixture:i1"});
  assert.equal(resolveVesselAcousticPath(definition, instance, {deckId: "main"}, {deckId: "lower"}).gain, 0.1);
  setVesselConnectionState(definition, instance, "down", "open");
  const path = resolveVesselAcousticPath(definition, instance, {deckId: "main"}, {deckId: "lower"});
  assert.equal(path.gain, 0.9);
  assert.equal(path.transitionMs, 200);
});

test("named deck entities feed grammatical forms into the existing speech layer", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "speech-fixture");
  const deck = definition.decks.find(item => item.id === "main");
  const helm = deck.objects.find(item => item.id === "helm");
  assert.equal(renderVesselEntityTemplate(deck, "Ты перешёл {into}."), "Ты перешёл на главную палубу.");
  assert.equal(renderVesselEntityTemplate(helm, "Ты {at}."), "Ты у штурвала.");
});

test("reconnect falls back to safe point and disconnect clears claimed station", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "reconnect-fixture");
  const instance = registry.createInstance(definition.id, {instanceId: "reconnect-fixture:i1"});
  assert.equal(safeReconnectPosition(definition, instance, 0, {deckId: "main", x: 99, y: 99}).x, -4);
  const boat = {id: 4, x: 0, y: 0, heading: 0};
  setVesselOccupantPosition(definition, instance, 0, {deckId: "main", x: -3, y: 0});
  performVesselDeckAction(registry, definition, instance, 0, {kind: "object", id: "helm"}, "occupy");
  syncWalkableVesselOccupants({players: [{activeBoat: null}]}, definition, instance, boat);
  assert.equal(instance.occupants[0], undefined);
  assert.equal(instance.interior.claims.helm, undefined);
  assert.equal(boat.vesselRuntimeState.occupantMemory[0].x, -3);
});

test("module degradation is opt-in and inertia is stable unless enabled", () => {
  const registry = createVesselRegistry();
  registry.registerModuleType({id: "simple", userFacing: false, createState: () => ({health: 50, enabled: true})});
  registry.registerModuleType({id: "linear", userFacing: false, createState: () => ({health: 50, enabled: true}), effectiveness: ({state}) => state.health / 100});
  const definition = registry.registerVesselType({id: "module-fixture", label: "module", modules: [{id: "a", type: "simple"}, {id: "b", type: "linear"}]});
  const instance = registry.createInstance(definition.id, {instanceId: "module-fixture:i1"});
  assert.equal(vesselModuleEffectiveness(registry, definition, instance, "a"), 1);
  assert.equal(vesselModuleEffectiveness(registry, definition, instance, "b"), 0.5);
  const deckRegistry = createVesselRegistry();
  const deck = fixture(deckRegistry, "inertia-fixture");
  assert.equal(vesselInertiaResponse(deck, "player", {lateralAcceleration: 10}).active, false);
  assert.equal(vesselInertiaResponse(deck, "cargo", {lateralAcceleration: 5}).overboardRisk, true);
});

test("persistence keeps physical deck state but not transient claims/traversals; network excludes static geometry", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "persist-fixture");
  const first = registry.createInstance(definition.id, {instanceId: "persist-fixture:i1"});
  adjustVesselZoneWater(definition, first, "main-zone", 55);
  setVesselConnectionState(definition, first, "down", "open");
  const saved = vesselDeckPersistentState(registry, definition, first);
  const second = registry.createInstance(definition.id, {instanceId: "persist-fixture:i2", deckState: saved});
  assert.equal(second.zones["main-zone"].flooding, 55);
  assert.equal(second.interior.connections.down.state, "open");
  assert.deepEqual(second.interior.claims, {});
  const snapshot = vesselNetworkSnapshot({}, registry, [{definition, instance: second, boat: {id: 1}}]);
  assert.ok(snapshot.vessels[0].interior);
  assert.equal(snapshot.vessels[0].decks, undefined);
  assert.equal(snapshot.vessels[0].definition, undefined);
});

test("zero hull enters gradual emergency lifecycle without ejecting occupants", () => {
  const registry = createVesselRegistry();
  const definition = fixture(registry, "sinking-fixture");
  const instance = registry.createInstance(definition.id, {instanceId: "sinking-fixture:i1"});
  setVesselOccupantPosition(definition, instance, 0, {deckId: "main", x: -3, y: 0});
  const state = advanceVesselDeckRuntime(definition, instance, 1, {boat: {hull: 0}});
  assert.equal(state.emergency.phase, "critical");
  assert.ok(instance.zones["main-zone"].flooding > 0);
  assert.ok(instance.occupants[0]);
});
