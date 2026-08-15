import test from "node:test";
import assert from "node:assert/strict";

import {FREE_STATE_ACK_TIMEOUT_MS} from "../src/worker-resilient-config.js";
import {FREE_STATE_STREAM_WINDOW} from "../src/worker-delivery-policy.js";
import {Lobby} from "../src/worker-resilient.js";

function testLobby(client) {
  const lobby = Object.create(Lobby.prototype);
  const sent = [];
  const socket = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  lobby.clients = new Map([[socket, client]]);
  return {lobby, socket, sent};
}

function freeState(sequence, events = []) {
  return {
    sequence,
    serverAt: Date.now(),
    ackInput: [12, 8],
    world: {
      time: sequence,
      players: [{x: sequence}, {x: 0}],
      boats: [{x: sequence}],
      events: [],
    },
    events,
  };
}

test("a lost ACK resends the stalled full state before a newer world is streamed", () => {
  const oldEvent = {type: "engine-stall", text: "Мотор заглох."};
  const queuedEvent = {type: "pump-start", text: "Насос включён."};
  const inFlight = freeState(40, [oldEvent]);
  const client = {
    mode: "free",
    role: "captain",
    freeStateInFlight: 40,
    freeStateSentAt: Date.now() - FREE_STATE_ACK_TIMEOUT_MS - 25,
    freeInFlightWorld: inFlight.world,
    freeInFlightState: inFlight,
    freeAckedWorld: freeState(39).world,
    freePending: freeState(40.5, [queuedEvent]),
    freeUnackedStreamStates: 1,
    freeStreamBaseWorld: inFlight.world,
  };
  const {lobby, socket, sent} = testLobby(client);

  lobby.offerFreeState(socket, freeState(41));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "free-state");
  assert.equal(sent[0].sequence, 40);
  assert.equal(sent[0].full, true);
  assert.deepEqual(sent[0].events, [oldEvent]);
  assert.equal(client.freeStateInFlight, 40);
  assert.equal(client.freePending.sequence, 41);
  assert.deepEqual(client.freePending.events, [queuedEvent]);
  assert.equal(client.freeStateResends, 1);

  client.freeAckedWorld = client.freeInFlightWorld;
  client.freeStateInFlight = 0;
  client.freeInFlightWorld = null;
  lobby.flushFreeState(socket);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sequence, 41);
  assert.deepEqual(sent[1].events, [queuedEvent]);
});

test("a recent in-flight state continues through the bounded streaming window", () => {
  const inFlight = freeState(50);
  const client = {
    mode: "free",
    role: "captain",
    freeStateInFlight: 50,
    freeStateSentAt: Date.now() - 50,
    freeInFlightWorld: inFlight.world,
    freeInFlightState: inFlight,
    freeAckedWorld: freeState(49).world,
    freePending: null,
    freeUnackedStreamStates: 1,
    freeStreamBaseWorld: inFlight.world,
  };
  const {lobby, socket, sent} = testLobby(client);

  lobby.offerFreeState(socket, freeState(51));
  lobby.offerFreeState(socket, freeState(52));

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(item => item.sequence), [51, 52]);
  assert.equal(sent.every(item => item.full === false), true);
  assert.equal(client.freeStateInFlight, 52);
  assert.equal(client.freePending, null);
  assert.equal(client.freeUnackedStreamStates, 3);
  assert.ok(client.freeUnackedStreamStates < FREE_STATE_STREAM_WINDOW);
  assert.equal(client.freeStateResends || 0, 0);
});
