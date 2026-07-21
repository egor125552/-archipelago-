import test from "node:test";
import assert from "node:assert/strict";

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.listeners = new Map();
    this.pendingMessages = [];
    this.peer = null;
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
    if (name === "message" && this.pendingMessages.length) {
      const pending = this.pendingMessages.splice(0);
      queueMicrotask(() => pending.forEach(data => this.emit("message", {data})));
    }
  }

  emit(name, event = {}) {
    for (const handler of this.listeners.get(name) || []) handler(event);
  }

  receive(data) {
    if ((this.listeners.get("message") || []).length) queueMicrotask(() => this.emit("message", {data}));
    else this.pendingMessages.push(data);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("socket closed");
    this.peer?.receive(data);
  }

  accept() {}

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close", {});
    if (this.peer?.readyState === 1) {
      this.peer.readyState = 3;
      this.peer.emit("close", {});
    }
  }
}

class FakeWebSocketPair {
  constructor() {
    const client = new FakeSocket();
    const server = new FakeSocket();
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
}

class FakeResponse {
  constructor(body = null, options = {}) {
    this.body = body;
    this.status = options.status || 200;
    this.headers = options.headers || {};
    this.webSocket = options.webSocket || null;
  }
}

globalThis.WebSocketPair = FakeWebSocketPair;
globalThis.Response = FakeResponse;

const {Lobby} = await import("../src/worker.js");

function connectRequest(role, mode = "ops") {
  return {
    url: `https://game.example/api/connect?role=${role}&mode=${mode}`,
    headers: {get: name => name.toLowerCase() === "upgrade" ? "websocket" : null},
  };
}

function collect(socket) {
  const messages = [];
  socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
  return messages;
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test("captain and crew enter one room and exchange gameplay packets", async () => {
  const lobby = new Lobby({});

  const captainResponse = await lobby.fetch(connectRequest("captain"));
  const captainMessages = collect(captainResponse.webSocket);
  await flush();
  assert.equal(captainResponse.status, 101);
  assert.equal(captainMessages[0].type, "lobby-ready");
  assert.equal(captainMessages[0].waitingFor, "crew");
  const room = captainMessages[0].room;

  captainResponse.webSocket.send(JSON.stringify({type: "snapshot", state: "initial"}));
  await flush();

  const crewResponse = await lobby.fetch(connectRequest("crew"));
  const crewMessages = collect(crewResponse.webSocket);
  await flush();

  assert.equal(crewMessages[0].type, "lobby-ready");
  assert.equal(crewMessages[0].room, room);
  assert.equal(crewMessages[0].matched, true);
  assert.ok(captainMessages.some(message => message.type === "peer-connected"));
  assert.ok(crewMessages.some(message => message.type === "peer-connected"));
  assert.ok(crewMessages.some(message => message.type === "snapshot" && message.state === "initial"));

  crewResponse.webSocket.send(JSON.stringify({type: "hello", role: "crew"}));
  await flush();
  assert.ok(captainMessages.some(message => message.type === "hello" && message.role === "crew"));

  captainResponse.webSocket.send(JSON.stringify({type: "control", control: "pump", active: true}));
  await flush();
  assert.ok(crewMessages.some(message => message.type === "control" && message.control === "pump"));
});

test("join button can create a crew room that later accepts a captain", async () => {
  const lobby = new Lobby({});
  const crewResponse = await lobby.fetch(connectRequest("crew"));
  const crewMessages = collect(crewResponse.webSocket);
  await flush();
  assert.equal(crewMessages[0].waitingFor, "captain");

  const captainResponse = await lobby.fetch(connectRequest("captain"));
  const captainMessages = collect(captainResponse.webSocket);
  await flush();
  assert.equal(captainMessages[0].room, crewMessages[0].room);
  assert.equal(captainMessages[0].matched, true);
});

test("a slow client drops stale world deltas but still receives recovery snapshots and events", async () => {
  const lobby = new Lobby({});
  const captainResponse = await lobby.fetch(connectRequest("captain", "free"));
  const captainMessages = collect(captainResponse.webSocket);
  const crewResponse = await lobby.fetch(connectRequest("crew", "free"));
  const crewMessages = collect(crewResponse.webSocket);
  await flush();

  const crewServerSocket = crewResponse.webSocket.peer;
  crewServerSocket.bufferedAmount = 80 * 1024;
  const before = crewMessages.length;
  captainResponse.webSocket.send(JSON.stringify({type: "free-snapshot", sequence: 8, world: {time: 4}}));
  captainResponse.webSocket.send(JSON.stringify({type: "free-delta", sequence: 9, delta: [1, {time: [0, 5]}]}));
  captainResponse.webSocket.send(JSON.stringify({type: "free-events", events: [{type: "collision"}]}));
  await flush();

  assert.equal(crewMessages.some(message => message.type === "free-snapshot" && message.sequence === 8), true);
  assert.equal(crewMessages.some(message => message.type === "free-delta" && message.sequence === 9), false);
  assert.equal(crewMessages.length, before + 2);
  assert.equal(crewMessages.at(-1).type, "free-events");
  assert.ok(captainMessages.some(message => message.type === "peer-connected"));

  crewServerSocket.bufferedAmount = 0;
  const afterRecovery = crewMessages.length;
  captainResponse.webSocket.send(JSON.stringify({type: "free-checkpoint", world: {time: 6, inputs: [{up: true}]}}));
  await flush();
  assert.equal(crewMessages.length, afterRecovery);
  assert.deepEqual(lobby.rooms.get(captainMessages[0].room).lastFreeSnapshot.world, {time: 6, inputs: [{up: true}]});
});
