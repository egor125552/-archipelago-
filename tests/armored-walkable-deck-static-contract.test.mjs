import test from "node:test";
import assert from "node:assert/strict";
import {vesselRegistry} from "../public/src/vessel/vessel-runtime.js";

test("armored deck connections are reciprocal and the helm is on the upper deck", () => {
  const definition = vesselRegistry().resolveVesselType("dual-turret-patrol");
  const main = definition.decks.find(deck => deck.id === "armored-main-deck");
  const bridge = definition.decks.find(deck => deck.id === "armored-bridge-deck");
  const up = main.connections.find(connection => connection.id === "armored-ladder-up");
  const down = bridge.connections.find(connection => connection.id === "armored-ladder-down");
  assert.equal(up.reverseId, down.id);
  assert.equal(down.reverseId, up.id);
  assert.equal(up.initialState, down.initialState);
  assert.equal(up.initialState, "closed");
  assert.equal(bridge.objects.find(object => object.id === "armored-helm-console")?.controlsVessel, true);
});
