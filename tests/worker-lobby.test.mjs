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
const {applyReplicatedWorldDelta} = await import("../public/src/free-roam-replication.js");

function connectRequest(role, mode = "ops", room = "") {
  const params = new URLSearchParams({role});
  if (mode === "free") params.set("mode", "free");
  if (room) params.set("room", room);
  return {
    url: `https://game.example/api/connect?${params}`,
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

function materializedFreeWorld(messages) {
  let world = null;
  for (const message of messages.filter(candidate => candidate.type === "free-state")) {
    world = message.full === false
      ? applyReplicatedWorldDelta(world, message.delta)
      : structuredClone(message.world);
  }
  return world;
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

test("free-roam is server authoritative and slow clients receive only the newest state", async () => {
  const lobby = new Lobby({});
  const captainResponse = await lobby.fetch(connectRequest("captain", "free"));
  const captainMessages = collect(captainResponse.webSocket);
  await flush();
  const roomId = captainMessages.find(message => message.type === "lobby-ready").room;
  const firstCaptainState = captainMessages.find(message => message.type === "free-state");
  assert.ok(firstCaptainState);
  assert.equal("inputs" in firstCaptainState.world, false);
  captainResponse.webSocket.send(JSON.stringify({
    type: "free-state-ack",
    sequence: firstCaptainState.sequence,
  }));
  await flush();

  const crewResponse = await lobby.fetch(connectRequest("crew", "free", roomId));
  const crewMessages = collect(crewResponse.webSocket);
  clearInterval(lobby.freeTickTimer);
  lobby.freeTickTimer = null;
  await flush();
  assert.equal(crewMessages.find(message => message.type === "lobby-ready").room, roomId);

  for (let round = 0; round < 2; round += 1) {
    for (const [response, messages] of [
      [captainResponse, captainMessages],
      [crewResponse, crewMessages],
    ]) {
      const latest = messages.filter(message => message.type === "free-state").at(-1);
      response.webSocket.send(JSON.stringify({type: "free-state-ack", sequence: latest.sequence}));
    }
    await flush();
  }
  const room = lobby.rooms.get(roomId);
  const before = room.freeServer.world.boats.map(boat => ({x: boat.x, y: boat.y}));
  captainResponse.webSocket.send(JSON.stringify({
    type: "free-input", sequence: 11, input: {up: true}, world: {forged: true},
  }));
  captainResponse.webSocket.send(JSON.stringify({
    type: "free-snapshot",
    world: {boats: [{x: 999_999, y: 999_999}]},
  }));
  crewResponse.webSocket.send(JSON.stringify({
    type: "free-input", sequence: 21, input: {up: true, left: true},
  }));
  await flush();
  const directRelay = captainMessages.find(message => message.type === "free-input" && message.sequence === 21);
  assert.equal(directRelay, undefined);
  assert.ok(captainMessages.some(message => message.type === "free-input-received" && message.sequence === 11));
  assert.equal(room.freeServer.world.boats[0].x, before[0].x);

  lobby.tickFreeRooms(room.freeServer.lastTickAt + 160);
  await flush();
  const captainState = captainMessages.filter(message => message.type === "free-state").at(-1);
  const crewState = crewMessages.filter(message => message.type === "free-state").at(-1);
  const captainWorld = materializedFreeWorld(captainMessages);
  const crewWorld = materializedFreeWorld(crewMessages);
  assert.deepEqual(captainWorld, crewWorld);
  assert.equal(captainState.ackInput, 11);
  assert.equal(crewState.ackInput, 21);
  assert.ok(Math.hypot(
    captainWorld.boats[0].x - before[0].x,
    captainWorld.boats[0].y - before[0].y,
  ) > 0.01);
  assert.ok(Math.hypot(
    captainWorld.boats[1].x - before[1].x,
    captainWorld.boats[1].y - before[1].y,
  ) > 0.01);

  const captainCountBeforeStall = captainMessages.filter(message => message.type === "free-state").length;
  const firstBlockedSequence = captainState.sequence;
  let now = room.freeServer.lastTickAt;
  for (let index = 0; index < 80; index += 1) {
    now += 40;
    lobby.tickFreeRooms(now);
  }
  await flush();
  assert.equal(
    captainMessages.filter(message => message.type === "free-state").length,
    captainCountBeforeStall,
    "no additional snapshot may be queued while the previous one is unacknowledged",
  );
  const captainClient = [...lobby.clients.values()].find(client => client.role === "captain" && client.mode === "free");
  assert.ok(captainClient.freePending.sequence > firstBlockedSequence);
  assert.ok((captainClient.freePending.events || []).length <= 128);

  captainResponse.webSocket.send(JSON.stringify({type: "free-state-ack", sequence: firstBlockedSequence}));
  await flush();
  const afterRecovery = captainMessages.filter(message => message.type === "free-state");
  assert.equal(afterRecovery.length, captainCountBeforeStall + 1);
  assert.equal(afterRecovery.at(-1).sequence, captainClient.freeStateInFlight);
  assert.ok(afterRecovery.at(-1).sequence >= firstBlockedSequence + 80);

  captainResponse.webSocket.close();
  crewResponse.webSocket.close();
});

test("a reconnect claims the same free-roam room and role", async () => {
  const lobby = new Lobby({});
  const first = await lobby.fetch(connectRequest("captain", "free"));
  const messages = collect(first.webSocket);
  await flush();
  const roomId = messages.find(message => message.type === "lobby-ready").room;
  first.webSocket.close();
  await flush();

  const reconnected = await lobby.fetch(connectRequest("captain", "free", roomId));
  const reconnectedMessages = collect(reconnected.webSocket);
  clearInterval(lobby.freeTickTimer);
  lobby.freeTickTimer = null;
  await flush();
  assert.equal(reconnectedMessages.find(message => message.type === "lobby-ready").room, roomId);
  assert.equal(reconnectedMessages.find(message => message.type === "lobby-ready").role, "captain");
  reconnected.webSocket.close();
});
