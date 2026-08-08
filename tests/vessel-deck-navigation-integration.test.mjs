import test from "node:test";
import assert from "node:assert/strict";

import {setVesselOccupantPosition} from "../public/src/vessel/vessel-interior.js";
import {
  listVesselInteriorNavigationTargets,
  vesselInteriorNavigationGuidance,
  vesselInteriorNavigationRoute,
} from "../public/src/vessel/vessel-navigation.js";
import {adjustVesselZoneWater, setVesselConnectionState} from "../public/src/vessel/vessel-deck-runtime.js";
import {spawnVessel, vesselRegistry} from "../public/src/vessel/vessel-runtime.js";

function ensureFixture() {
  const registry = vesselRegistry();
  const existing = registry.resolveVesselType("deck-navigation-integration-fixture");
  if (existing) return existing;
  return registry.registerVesselType({
    id: "deck-navigation-integration-fixture",
    label: "Навигационная платформа",
    capabilities: {walkableInterior: true, replicates: true},
    deckArchitecture: {
      boarding: {mode: "deck-entry", points: [{id: "entry", deckId: "main", position: [-4, 0]}]},
    },
    decks: [
      {
        id: "main", label: "главная палуба",
        shape: {outer: [[-5,-5],[5,-5],[5,5],[-5,5]], holes: [[[-1,-1],[1,-1],[1,1],[-1,1]]]},
        connections: [{
          id: "down", kind: "hatch", label: "люк вниз", toDeckId: "lower", reverseId: "up", from: [0,-4],
          initialState: "open", states: ["open","closed"], passableStates: ["open"],
        }],
      },
      {
        id: "lower", label: "нижняя палуба",
        shape: {outer: [[-4,-4],[4,-4],[4,4],[-4,4]]},
        zones: [{id: "pump-room", label: "насосная", shape: {outer: [[-4,-4],[4,-4],[4,4],[-4,4]]}, water: {enabled: true, maxDepth: 2}}],
        objects: [{id: "pump", kind: "object", label: "аварийный насос", position: [2,2], zoneId: "pump-room"}],
        connections: [{
          id: "up", kind: "hatch", label: "люк наверх", toDeckId: "main", reverseId: "down", from: [0,3],
          initialState: "open", states: ["open","closed"], passableStates: ["open"],
        }],
      },
    ],
  });
}

test("shared vessel navigation guides through live deck topology and warns without avoiding passable hazards", () => {
  const definition = ensureFixture();
  const world = {boats: [], players: [{activeBoat: null}]};
  const {instance, boat} = spawnVessel(world, definition.id, {x: 100, y: 100});
  world.players[0].activeBoat = boat.id;
  setVesselOccupantPosition(definition, instance, 0, {deckId: "main", x: -4, y: 0, heading: 0});

  const pumpTarget = listVesselInteriorNavigationTargets(world, 0).find(target => target.entityId === "pump");
  assert.ok(pumpTarget, "pump must be exposed through the common vessel navigation target list");

  const openRoute = vesselInteriorNavigationRoute(world, 0, pumpTarget.id);
  assert.ok(openRoute);
  assert.ok(openRoute.waypoints.some(waypoint => waypoint.kind === "connection" && waypoint.connectionId === "down"));
  const guidance = vesselInteriorNavigationGuidance(world, 0, pumpTarget.id);
  assert.equal(guidance.arrived, false);
  assert.ok(Number.isFinite(guidance.relativeBearing));

  setVesselConnectionState(definition, instance, "down", "closed");
  assert.equal(vesselInteriorNavigationRoute(world, 0, pumpTarget.id), null, "closed hatch must physically block the route");

  setVesselConnectionState(definition, instance, "down", "open");
  adjustVesselZoneWater(definition, instance, "pump-room", 50);
  const hazardousRoute = vesselInteriorNavigationRoute(world, 0, pumpTarget.id);
  assert.ok(hazardousRoute, "a hazardous but passable route must remain available");
  assert.ok(hazardousRoute.warnings.some(warning => warning.zoneId === "pump-room" && warning.warnings.some(text => /затопление/.test(text))));
});
