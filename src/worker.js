import {chooseAnyWaitingRoom, chooseWaitingRoom, createRoomCode, missingRole, oppositeRole, publicRoomList} from "./lobby-core.js";
import {
  FREE_TICK_MS,
  applyServerFreeInput,
  createServerFreeRoom,
  freePlayerIndex,
  setServerFreePresence,
  snapshotServerFreeRoom,
  tickServerFreeRoom,
} from "./free-roam-server.js";
import {diffReplicatedWorld} from "../public/src/free-roam-replication.js";

const SOUND_PROXY = Object.freeze({
  "/api/sound/footstep-1.ogg": "https://opengameart.org/sites/default/files/01-footstep_0.ogg",
  "/api/sound/footstep-2.ogg": "https://opengameart.org/sites/default/files/02-footstep.ogg",
  "/api/sound/footstep-3.ogg": "https://opengameart.org/sites/default/files/03-footstep.ogg",
});

const ROOM_HEARTBEAT_TIMEOUT_MS = 18_000;
const FREE_RECONNECT_GRACE_MS = 120_000;
const ROOM_ROLES = Object.freeze(["captain", "crew"]);
const MAX_PENDING_FREE_EVENTS = 128;

function compactPendingFreeEvents(events) {
  if (events.length <= MAX_PENDING_FREE_EVENTS) return events;
  const described = events
    .map((event, index) => ({event, index}))
    .filter(({event}) => Boolean(event?.text))
    .slice(-96);
  const ambient = events
    .map((event, index) => ({event, index}))
    .filter(({event}) => !event?.text)
    .slice(-32);
  return [...described, ...ambient]
    .sort((left, right) => left.index - right.index)
    .map(({event}) => event);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function proxySound(request, source) {
  const cache = caches.default;
  const cacheKey = new Request(request.url, {method: "GET"});
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const upstream = await fetch(source, {headers: {"user-agent": "Echo-Archipelago/1.0"}});
  if (!upstream.ok || !upstream.body) return new Response("Sound unavailable", {status: 502});
  const response = new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "audio/ogg",
      "cache-control": "public, max-age=604800, immutable",
      "x-content-type-options": "nosniff",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

function safeSend(socket, payload) {
  try {
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify(payload));
    return true;
  } catch (_) { return false; }
}

function parseMessage(data) {
  try { return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  catch (_) { return null; }
}

function roomMode(url) {
  return url.searchParams.get("mode") === "free" ? "free" : "ops";
}

function socketLooksOpen(socket) {
  return Boolean(socket && (socket.readyState == null || socket.readyState === 1));
}

export class Lobby {
  constructor(state) {
    this.state = state;
    this.rooms = new Map();
    this.clients = new Map();
    this.freeTickTimer = null;
  }

  ensureFreeRoom(room, now = Date.now()) {
    if (room?.mode !== "free") return null;
    room.freeServer ||= createServerFreeRoom(now);
    return room.freeServer;
  }

  ensureFreeTicker() {
    if (this.freeTickTimer) return;
    this.freeTickTimer = setInterval(() => this.tickFreeRooms(Date.now()), FREE_TICK_MS);
    this.freeTickTimer?.unref?.();
  }

  stopFreeTickerIfIdle() {
    const active = [...this.rooms.values()].some(room => (
      room.mode === "free" && (socketLooksOpen(room.captain) || socketLooksOpen(room.crew))
    ));
    if (active || !this.freeTickTimer) return;
    clearInterval(this.freeTickTimer);
    this.freeTickTimer = null;
  }

  offerFreeState(socket, state) {
    const client = this.clients.get(socket);
    if (!client || client.mode !== "free" || !state) return;
    const previousEvents = client.freePending?.events || [];
    client.freePending = {
      ...state,
      events: compactPendingFreeEvents([...previousEvents, ...(state.events || [])]),
    };
    this.flushFreeState(socket);
  }

  flushFreeState(socket) {
    const client = this.clients.get(socket);
    if (!client || client.mode !== "free" || client.freeStateInFlight || !client.freePending) return false;
    const pending = client.freePending;
    const playerIndex = freePlayerIndex(client.role);
    const full = !client.freeAckedWorld;
    const payload = {
      type: "free-state",
      sequence: pending.sequence,
      serverAt: pending.serverAt,
      ackInput: pending.ackInput?.[playerIndex] || 0,
      full,
      events: pending.events || [],
    };
    if (full) payload.world = pending.world;
    else payload.delta = diffReplicatedWorld(client.freeAckedWorld, pending.world);
    const sent = safeSend(socket, payload);
    if (!sent) return false;
    client.freePending = null;
    client.freeStateInFlight = pending.sequence;
    client.freeInFlightWorld = pending.world;
    return true;
  }

  broadcastFreeState(room, state) {
    for (const role of ROOM_ROLES) {
      if (room?.[role]) this.offerFreeState(room[role], state);
    }
  }

  tickFreeRooms(now = Date.now()) {
    for (const room of this.rooms.values()) {
      if (room.mode !== "free" || (!room.captain && !room.crew)) continue;
      const serverRoom = this.ensureFreeRoom(room, now);
      this.broadcastFreeState(room, tickServerFreeRoom(serverRoom, now));
    }
  }

  touch(room, role, now = Date.now()) {
    room.lastSeen ||= {captain: 0, crew: 0};
    room.lastSeen[role] = now;
  }

  replaceFreeRoleConnection(room, role) {
    const previousSocket = room?.[role];
    if (!previousSocket || room?.mode !== "free") return false;
    // A mobile network hand-off can leave Cloudflare believing the old socket
    // is still open after the browser has already lost it. An exact room/role
    // reconnect is the player's proof of intent to resume that slot, so retire
    // the stale transport without clearing presence or notifying the teammate.
    this.clients.delete(previousSocket);
    room[role] = null;
    room.pending[role] = [];
    room.lastSeen ||= {captain: 0, crew: 0};
    room.lastSeen[role] = 0;
    try { previousSocket.close(4102, "replaced-by-reconnect"); } catch (_) {}
    return true;
  }

  removeRole(room, role, notify = true) {
    const socket = room?.[role];
    if (!socket) return;
    if (room.mode === "free") setServerFreePresence(this.ensureFreeRoom(room), role, false);
    this.clients.delete(socket);
    room[role] = null;
    room.pending[role] = [];
    room.lastSeen ||= {captain: 0, crew: 0};
    room.lastSeen[role] = 0;
    if (!room.captain && !room.crew && room.mode === "free") room.emptySince = Date.now();
    const otherRole = oppositeRole(role);
    const other = room[otherRole];
    if (notify && other) {
      safeSend(other, {type: "network-closed", mode: room.mode || "ops", waitingFor: role});
      if (room.mode === "free") {
        this.offerFreeState(other, snapshotServerFreeRoom(room.freeServer, Date.now()));
      }
    }
    this.stopFreeTickerIfIdle();
  }

  pruneRooms(now = Date.now()) {
    for (const room of this.rooms.values()) {
      room.lastSeen ||= {captain: room.createdAt || now, crew: room.createdAt || now};
      for (const role of ROOM_ROLES) {
        const socket = room[role];
        if (!socket) continue;
        const lastSeen = Number(room.lastSeen[role]) || Number(room.createdAt) || now;
        const expired = now - lastSeen > ROOM_HEARTBEAT_TIMEOUT_MS;
        const freeRoomWithLiveSocket = room.mode === "free" && socketLooksOpen(socket);
        if (!socketLooksOpen(socket) || (expired && !freeRoomWithLiveSocket)) {
          this.removeRole(room, role, true);
        }
      }
      if (!room.captain && !room.crew) {
        const keepForReconnect = room.mode === "free"
          && now - (Number(room.emptySince) || now) < FREE_RECONNECT_GRACE_MS;
        if (!keepForReconnect) this.rooms.delete(room.id);
      }
    }
    this.stopFreeTickerIfIdle();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const mode = roomMode(url);
    this.pruneRooms();

    if (url.pathname === "/api/rooms") {
      return json({rooms: publicRoomList(this.rooms, Date.now(), mode), online: this.clients.size, mode});
    }

    if (url.pathname !== "/api/connect") return new Response("Not found", {status: 404});
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({error: "WebSocket required"}, 426);
    }

    const requestedRole = url.searchParams.get("role");
    const requestedRoom = String(url.searchParams.get("room") || "").trim().slice(0, 32);
    let role = requestedRole === "captain" ? "captain" : requestedRole === "auto" ? "auto" : "crew";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let room = null;
    let preferredRoomFound = false;
    let replacedConnection = false;
    if (role === "auto") {
      if (requestedRoom) {
        const preferred = this.rooms.get(requestedRoom);
        if (preferred && (preferred.mode || "ops") === mode && missingRole(preferred)) {
          room = preferred;
          preferredRoomFound = true;
        }
      }
      if (!room) room = chooseAnyWaitingRoom(this.rooms, mode);
      role = missingRole(room) || "captain";
    } else {
      const preferred = requestedRoom ? this.rooms.get(requestedRoom) : null;
      if (preferred && (preferred.mode || "ops") === mode) {
        if (!preferred[role]) {
          room = preferred;
          preferredRoomFound = true;
        } else if (mode === "free") {
          room = preferred;
          preferredRoomFound = true;
          replacedConnection = this.replaceFreeRoleConnection(room, role);
        }
      }
      if (!room) room = chooseWaitingRoom(this.rooms, role, mode);
    }

    const created = !room;
    if (!room) {
      let id;
      const prefix = mode === "free" ? "FREE" : "SEA";
      do { id = createRoomCode(null, prefix); } while (this.rooms.has(id));
      room = {
        id,
        mode,
        captain: null,
        crew: null,
        createdAt: Date.now(),
        pending: {captain: [], crew: []},
        lastSeen: {captain: 0, crew: 0},
        emptySince: 0,
        freeServer: mode === "free" ? createServerFreeRoom(Date.now()) : null,
      };
      this.rooms.set(id, room);
    }

    room[role] = server;
    room.emptySince = 0;
    if (mode === "free") {
      setServerFreePresence(this.ensureFreeRoom(room), role, true);
      this.ensureFreeTicker();
    }
    this.touch(room, role);
    this.clients.set(server, {
      roomId: room.id,
      role,
      mode,
      freeStateInFlight: 0,
      freeInFlightWorld: null,
      freeAckedWorld: null,
      freePending: null,
    });

    server.addEventListener("message", event => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    const matched = Boolean(room.captain && room.crew);
    safeSend(server, {
      type: "lobby-ready",
      room: room.id,
      role,
      requestedRole: requestedRole || "crew",
      requestedRoom: requestedRoom || null,
      preferredRoomFound,
      replacedConnection,
      replacedStale: Boolean(requestedRoom && !preferredRoomFound && created),
      created,
      mode,
      matched,
      waitingFor: matched ? null : oppositeRole(role),
      serverAuthoritative: mode === "free",
    });

    if (mode === "free") {
      this.offerFreeState(server, snapshotServerFreeRoom(room.freeServer, Date.now()));
    }

    if (matched) this.finishMatch(room);

    return new Response(null, {status: 101, webSocket: client});
  }

  finishMatch(room) {
    safeSend(room.captain, {type: "peer-connected", room: room.id, mode: room.mode || "ops"});
    safeSend(room.crew, {type: "peer-connected", room: room.id, mode: room.mode || "ops"});

    if (room.mode === "free") {
      this.broadcastFreeState(room, snapshotServerFreeRoom(this.ensureFreeRoom(room), Date.now()));
      return;
    }
    for (const message of room.pending.captain.splice(0)) safeSend(room.crew, message);
    for (const message of room.pending.crew.splice(0)) safeSend(room.captain, message);
  }

  onMessage(socket, rawData) {
    const client = this.clients.get(socket);
    if (!client) return;
    const room = this.rooms.get(client.roomId);
    if (!room) return;
    this.touch(room, client.role);
    const message = parseMessage(rawData);
    if (!message || typeof message !== "object") return;
    if (message.type === "heartbeat") return;

    if (client.mode === "free") {
      if (message.type === "free-ping") {
        safeSend(socket, {type: "free-pong", nonce: message.nonce});
        return;
      }
      if (message.type === "free-input") {
        const accepted = applyServerFreeInput(room.freeServer, client.role, message.input, message.sequence);
        safeSend(socket, {
          type: "free-input-received",
          sequence: Math.max(0, Number(message.sequence) || 0),
          accepted,
          serverAt: Date.now(),
        });
        return;
      }
      if (message.type === "free-state-ack") {
        const acknowledged = Math.max(0, Number(message.sequence) || 0);
        if (acknowledged >= client.freeStateInFlight) {
          client.freeAckedWorld = client.freeInFlightWorld;
          client.freeStateInFlight = 0;
          client.freeInFlightWorld = null;
          this.flushFreeState(socket);
        }
        return;
      }
      if (message.type === "free-resync") {
        client.freeStateInFlight = 0;
        client.freeInFlightWorld = null;
        client.freeAckedWorld = null;
        client.freePending = null;
        this.offerFreeState(socket, snapshotServerFreeRoom(room.freeServer, Date.now()));
        return;
      }
      // Free-roam clients submit commands only. World snapshots and combat
      // events are produced exclusively by the Durable Object.
      return;
    }

    const otherRole = oppositeRole(client.role);
    const other = room[otherRole];
    if (other) {
      safeSend(other, message);
      return;
    }

    const queue = room.pending[client.role];
    if (message.type === "snapshot") {
      const previous = queue.findIndex(item => item?.type === message.type);
      if (previous >= 0) queue.splice(previous, 1);
    }
    queue.push(message);
    if (queue.length > 24) queue.splice(0, queue.length - 24);
  }

  onClose(socket) {
    const client = this.clients.get(socket);
    if (!client) return;
    const room = this.rooms.get(client.roomId);
    if (!room) {
      this.clients.delete(socket);
      return;
    }
    if (room[client.role] === socket) this.removeRole(room, client.role, true);
    else this.clients.delete(socket);
    if (!room.captain && !room.crew && room.mode !== "free") this.rooms.delete(room.id);
    this.stopFreeTickerIfIdle();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const soundSource = SOUND_PROXY[url.pathname];
    if (soundSource) return proxySound(request, soundSource);
    if (url.pathname.startsWith("/api/")) {
      const id = env.LOBBY.idFromName("global");
      return env.LOBBY.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
