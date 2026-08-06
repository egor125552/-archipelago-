import test from "node:test";
import assert from "node:assert/strict";

import {
  FREE_STATE_ACK_TIMEOUT_MS,
  Lobby,
} from "../src/worker-resilient.js";

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

test("a lost free-state ACK is replaced by a fresh full snapshot", () => {
  const oldEvent = {type: "engine-stall", text: "Мотор заглох."};
  const newEvent = {type: "cargo-stowed", text: "Ящик погружён."};
  const client = {
    mode: "free",
    role: "captain",
    freeStateInFlight: 40,
    freeStateSentAt: Date.now() - FREE_STATE_ACK_TIMEOUT_MS - 25,
    freeInFlightWorld: freeState(40).world,
    freeAckedWorld: freeState(39).world,
    freeInFlightEvents: [oldEvent],
    freePending: null,
  };
  const {lobby, socket, sent} = testLobby(client);

  lobby.offerFreeState(socket, freeState(41, [newEvent]));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "free-state");
  assert.equal(sent[0].sequence, 41);
  assert.equal(sent[0].full, true);
  assert.deepEqual(sent[0].events, [oldEvent, newEvent]);
  assert.equal(client.freeStateInFlight, 41);
  assert.equal(client.freeAckedWorld, null);
  assert.equal(client.freeStateResends, 1);
  assert.ok(client.freeStateSentAt > 0);
});

test("a recent in-flight state remains stop-and-wait and keeps only the newest pending world", () => {
  const client = {
    mode: "free",
    role: "captain",
    freeStateInFlight: 50,
    freeStateSentAt: Date.now() - 50,
    freeInFlightWorld: freeState(50).world,
    freeAckedWorld: freeState(49).world,
    freeInFlightEvents: [],
    freePending: null,
  };
  const {lobby, socket, sent} = testLobby(client);

  lobby.offerFreeState(socket, freeState(51));
  lobby.offerFreeState(socket, freeState(52));

  assert.equal(sent.length, 0);
  assert.equal(client.freeStateInFlight, 50);
  assert.equal(client.freePending.sequence, 52);
  assert.equal(client.freeStateResends || 0, 0);
});
