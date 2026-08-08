import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, setPlayerInput, stepFreeWorld} from "../public/src/free-roam-core-v8.js";
import {nativeVesselForBoat, vesselRegistry} from "../public/src/vessel/vessel-runtime.js";
import {setVesselOccupantPosition} from "../public/src/vessel/vessel-interior.js";

function armoredBoat(world) {
  return (world.boats || []).find(boat => boat?.vesselType === "dual-turret-patrol" || boat?.boatType === "dual-turret-patrol");
}

function tap(world, playerIndex, field) {
  setPlayerInput(world, playerIndex, {[field]: false});
  setPlayerInput(world, playerIndex, {[field]: true});
}

function boardArmoredDeck(world, playerIndex = 0) {
  const boat = armoredBoat(world);
  assert.ok(boat, "armored boat fixture must exist");
  for (const candidate of world.boats || []) if (candidate && candidate !== boat) candidate.reserved = true;
  boat.driver = null;
  boat.crew = [null, null];
  boat.speed = 0;
  boat.throttle = 0;
  const player = world.players[playerIndex];
  player.mode = "swim";
  player.activeBoat = null;
  player.x = boat.x;
  player.y = boat.y + 4;
  setPlayerInput(world, playerIndex, {action: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, playerIndex, {action: false});
  return boat;
}

test("armored patrol now uses the generic two-deck walkable definition", () => {
  const definition = vesselRegistry().resolveVesselType("dual-turret-patrol");
  assert.equal(definition.capabilities.walkableInterior, true);
  assert.equal(definition.deckArchitecture.boarding.mode, "deck-entry");
  assert.equal(definition.deckArchitecture.control.mode, "stations");
  assert.deepEqual(definition.decks.map(deck => deck.id), ["armored-main-deck", "armored-bridge-deck"]);
  const ladder = definition.decks[0].connections.find(connection => connection.id === "armored-ladder-up");
  assert.equal(ladder.kind, "hatch");
  assert.equal(ladder.initialState, "closed");
  assert.equal(ladder.traversal.mode, "geometry");
  const helm = definition.decks[1].objects.find(object => object.id === "armored-helm-console");
  assert.equal(helm.kind, "station");
  assert.equal(helm.controlsVessel, true);
  assert.equal(vesselRegistry().resolveVesselType("standard").decks.length, 0, "ordinary boat stays in simple direct-control mode");
});

test("player can board, walk, open the hatch, climb, take the helm, leave it and jump overboard", () => {
  const world = createFreeWorld();
  const boat = boardArmoredDeck(world, 0);
  const player = world.players[0];
  const entry = nativeVesselForBoat(world, boat.id);
  const boardingDiagnostic = JSON.stringify({
    player: {mode: player.mode, activeBoat: player.activeBoat, deckOwned: player.vesselDeckInputOwned},
    boat: {id: boat.id, driver: boat.driver, crew: boat.crew, reserved: boat.reserved},
    occupants: entry?.instance?.occupants || null,
    occupantMemory: boat.vesselRuntimeState?.occupantMemory || null,
    events: (world.events || []).slice(-12).map(event => ({type: event.type, text: event.text, sourcePlayer: event.sourcePlayer, boatId: event.boatId, targets: event.targets})),
  });
  assert.ok(entry?.instance?.occupants?.[0], `boarding must create a vessel-local occupant: ${boardingDiagnostic}`);
  assert.equal(entry.instance.occupants[0].deckId, "armored-main-deck");
  assert.equal(player.vesselDeckInputOwned, true);
  assert.equal(boat.driver, null, "boarding the deck must not magically claim the helm");

  const startY = entry.instance.occupants[0].y;
  setPlayerInput(world, 0, {up: true});
  stepFreeWorld(world, 0.1);
  setPlayerInput(world, 0, {up: false});
  assert.ok(entry.instance.occupants[0].y > startY, "up moves the player across the vessel-local deck");
  assert.equal(boat.speed, 0, "walking on deck must not drive the boat");

  setVesselOccupantPosition(entry.definition, entry.instance, 0, {deckId: "armored-main-deck", x: 0, y: 3.7, heading: 0});
  tap(world, 0, "action");
  assert.equal(entry.instance.interior.connections["armored-ladder-up"].state, "open");

  setPlayerInput(world, 0, {action: false});
  setPlayerInput(world, 0, {action: true});
  assert.ok(entry.instance.interior.traversals[0], "second action starts the real timed ladder traversal");
  assert.ok(entry.instance.interior.traversals[0].duration > 0);
  setPlayerInput(world, 0, {action: false});
  for (let index = 0; index < 40 && entry.instance.occupants[0].deckId !== "armored-bridge-deck"; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(entry.instance.occupants[0].deckId, "armored-bridge-deck");
  assert.equal(entry.instance.interior.connections["armored-ladder-up"].state, "closed", "hatch closes after traversal");

  setVesselOccupantPosition(entry.definition, entry.instance, 0, {deckId: "armored-bridge-deck", x: 0, y: 1.4, heading: 0});
  tap(world, 0, "action");
  assert.equal(entry.instance.interior.claims["armored-helm-control"], 0);
  assert.equal(boat.driver, 0, "physical helm station grants authoritative boat control");

  setPlayerInput(world, 0, {up: true});
  for (let index = 0; index < 5; index += 1) stepFreeWorld(world, 0.1);
  setPlayerInput(world, 0, {up: false});
  assert.ok(Math.abs(Number(boat.speed) || 0) > 0 || Math.abs(Number(boat.throttle) || 0) > 0, "normal boat controls work while the helm is occupied");

  tap(world, 0, "action");
  assert.equal(entry.instance.interior.claims["armored-helm-control"], undefined);
  assert.equal(boat.driver, null);

  setVesselOccupantPosition(entry.definition, entry.instance, 0, {deckId: "armored-main-deck", x: 0, y: 5.45, heading: 0});
  tap(world, 0, "jump");
  assert.equal(player.activeBoat, null);
  assert.equal(player.mode, "swim");
  assert.equal(entry.instance.occupants[0], undefined);
});
