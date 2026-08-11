import test from "node:test";
import assert from "node:assert/strict";

import {
  FREE_STATE_STREAM_WINDOW,
  LIVE_DOCUMENT_CACHE_CONTROL,
  VERSIONED_ASSET_CACHE_CONTROL,
  browserCacheControl,
  resetStreamWindowAfterAck,
  streamWindowCanSend,
} from "../src/worker-delivery-policy.js";
import {Lobby as ResilientLobby} from "../src/worker-resilient.js";

function world(sequence) {
  return {
    time: sequence / 10,
    players: [],
    boats: [],
    events: [],
    freeActivities: {inputs: [], previousInputs: []},
  };
}

function transportFixture() {
  const sent = [];
  const socket = {
    readyState: 1,
    send(payload) { sent.push(JSON.parse(payload)); },
  };
  const lobby = Object.create(ResilientLobby.prototype);
  const client = {
    mode: "free",
    role: "captain",
    freeStateInFlight: 0,
    freeInFlightWorld: null,
    freeAckedWorld: null,
    freePending: null,
  };
  lobby.clients = new Map([[socket, client]]);
  return {lobby, client, socket, sent};
}

function offer(client, sequence) {
  client.freePending = {
    sequence,
    serverAt: 1000 + sequence,
    ackInput: [sequence, 0],
    world: world(sequence),
    events: [],
  };
}

test("versioned production modules are browser-cacheable while live HTML stays fresh", () => {
  assert.equal(browserCacheControl("https://game.test/free-roam"), LIVE_DOCUMENT_CACHE_CONTROL);
  assert.equal(browserCacheControl("https://game.test/free-roam.html?v=9"), LIVE_DOCUMENT_CACHE_CONTROL);
  assert.equal(browserCacheControl("https://game.test/src/free-roam-v4.js?v=66"), VERSIONED_ASSET_CACHE_CONTROL);
  assert.equal(browserCacheControl("https://game.test/free-roam.css?v=7"), VERSIONED_ASSET_CACHE_CONTROL);
  assert.equal(browserCacheControl("https://game.test/src/free-roam-v4.js"), LIVE_DOCUMENT_CACHE_CONTROL);
});

test("high latency may keep several ordered world states in flight before an ACK", () => {
  const {lobby, client, socket, sent} = transportFixture();

  for (let sequence = 1; sequence <= FREE_STATE_STREAM_WINDOW; sequence += 1) {
    offer(client, sequence);
    assert.equal(lobby.flushFreeState(socket), true, `state ${sequence} should fit inside the streaming window`);
  }

  assert.equal(sent.length, FREE_STATE_STREAM_WINDOW);
  assert.equal(sent[0].full, true, "the first state establishes a complete client base");
  assert.equal(sent[1].full, false, "later states are ordered deltas against the previous transmitted world");
  assert.equal(client.freeStateInFlight, FREE_STATE_STREAM_WINDOW, "legacy ACK alias tracks the newest sequence in the ordered window");
  assert.equal(streamWindowCanSend(client), false);

  offer(client, FREE_STATE_STREAM_WINDOW + 1);
  assert.equal(lobby.flushFreeState(socket), false, "one extra state waits instead of growing an unbounded queue");
  assert.equal(sent.length, FREE_STATE_STREAM_WINDOW);
});

test("acknowledging the newest ordered state opens the delivery window immediately", () => {
  const {lobby, client, socket, sent} = transportFixture();

  for (let sequence = 1; sequence <= FREE_STATE_STREAM_WINDOW; sequence += 1) {
    offer(client, sequence);
    lobby.flushFreeState(socket);
  }
  const acknowledgedWorld = client.freeInFlightWorld;

  // This is the state transition performed by worker.js when the newest
  // sequence is acknowledged. The resilient transport then owns window reset.
  client.freeAckedWorld = acknowledgedWorld;
  client.freeStateInFlight = 0;
  client.freeInFlightWorld = null;
  offer(client, FREE_STATE_STREAM_WINDOW + 1);

  assert.equal(resetStreamWindowAfterAck(client), true);
  assert.equal(streamWindowCanSend(client), true);
  assert.equal(lobby.flushFreeState(socket), true);
  assert.equal(sent.at(-1).sequence, FREE_STATE_STREAM_WINDOW + 1);
  assert.equal(sent.at(-1).full, false, "post-ACK delivery continues from the acknowledged world without a full resync");
});
