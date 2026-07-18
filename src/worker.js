import {chooseAnyWaitingRoom, chooseWaitingRoom, createRoomCode, missingRole, oppositeRole, publicRoomList} from "./lobby-core.js";

const SOUND_PROXY = Object.freeze({
  "/api/sound/footstep-1.ogg": "https://opengameart.org/sites/default/files/01-footstep_0.ogg",
  "/api/sound/footstep-2.ogg": "https://opengameart.org/sites/default/files/02-footstep.ogg",
  "/api/sound/footstep-3.ogg": "https://opengameart.org/sites/default/files/03-footstep.ogg",
});

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
    if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
  } catch (_) {}
}

function parseMessage(data) {
  try { return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  catch (_) { return null; }
}

function roomMode(url) {
  return url.searchParams.get("mode") === "free" ? "free" : "ops";
}

export class Lobby {
  constructor(state) {
    this.state = state;
    this.rooms = new Map();
    this.clients = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const mode = roomMode(url);
    if (url.pathname === "/api/rooms") {
      return json({rooms: publicRoomList(this.rooms, Date.now(), mode), online: this.clients.size, mode});
    }

    if (url.pathname !== "/api/connect") return new Response("Not found", {status: 404});
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({error: "WebSocket required"}, 426);
    }

    const requestedRole = url.searchParams.get("role");
    let role = requestedRole === "captain" ? "captain" : requestedRole === "auto" ? "auto" : "crew";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let room = null;
    if (role === "auto") {
      room = chooseAnyWaitingRoom(this.rooms, mode);
      role = missingRole(room) || "captain";
    } else {
      room = chooseWaitingRoom(this.rooms, role, mode);
    }

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
      };
      this.rooms.set(id, room);
    }

    room[role] = server;
    this.clients.set(server, {roomId: room.id, role, mode});

    server.addEventListener("message", event => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    const matched = Boolean(room.captain && room.crew);
    safeSend(server, {
      type: "lobby-ready",
      room: room.id,
      role,
      requestedRole: requestedRole || "crew",
      mode,
      matched,
      waitingFor: matched ? null : oppositeRole(role),
    });

    if (matched) this.finishMatch(room);

    return new Response(null, {status: 101, webSocket: client});
  }

  finishMatch(room) {
    safeSend(room.captain, {type: "peer-connected", room: room.id, mode: room.mode || "ops"});
    safeSend(room.crew, {type: "peer-connected", room: room.id, mode: room.mode || "ops"});

    for (const message of room.pending.captain.splice(0)) safeSend(room.crew, message);
    for (const message of room.pending.crew.splice(0)) safeSend(room.captain, message);
  }

  onMessage(socket, rawData) {
    const client = this.clients.get(socket);
    if (!client) return;
    const room = this.rooms.get(client.roomId);
    if (!room) return;
    const message = parseMessage(rawData);
    if (!message || typeof message !== "object") return;

    const otherRole = oppositeRole(client.role);
    const other = room[otherRole];
    if (other) {
      safeSend(other, message);
      return;
    }

    const queue = room.pending[client.role];
    if (message.type === "snapshot" || message.type === "free-snapshot") {
      const previous = queue.findIndex(item => item?.type === message.type);
      if (previous >= 0) queue.splice(previous, 1);
    }
    queue.push(message);
    if (queue.length > 24) queue.splice(0, queue.length - 24);
  }

  onClose(socket) {
    const client = this.clients.get(socket);
    if (!client) return;
    this.clients.delete(socket);

    const room = this.rooms.get(client.roomId);
    if (!room) return;
    if (room[client.role] === socket) room[client.role] = null;
    room.pending[client.role] = [];

    const otherRole = oppositeRole(client.role);
    const other = room[otherRole];
    if (other) {
      safeSend(other, {type: "network-closed", mode: room.mode || "ops", waitingFor: client.role});
    } else {
      this.rooms.delete(room.id);
    }
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
