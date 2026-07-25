import baseWorker, {Lobby as MemoryLobby} from "./worker.js";
import {setServerFreePresence} from "./free-roam-server.js";

const ROOM_STORAGE_PREFIX = "free-room-v1:";
const ROOM_ROLES = Object.freeze(["captain", "crew"]);
const PERSIST_INTERVAL_MS = 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function socketLooksOpen(socket) {
  return Boolean(socket && (socket.readyState == null || socket.readyState === 1));
}

function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function storedRoom(room, savedAt = Date.now()) {
  return {
    version: 1,
    savedAt,
    id: room.id,
    mode: room.mode,
    createdAt: room.createdAt,
    lastSeen: {...(room.lastSeen || {})},
    emptySince: Number(room.emptySince) || 0,
    freeServer: cloneValue(room.freeServer),
  };
}

function restoredRoom(saved, now = Date.now()) {
  if (!saved || saved.mode !== "free" || !saved.id || !saved.freeServer?.world) return null;
  const freeServer = cloneValue(saved.freeServer);
  freeServer.lastTickAt = now;
  // WebSocket transports never survive a Durable Object restart. Keep the
  // actual world, but clear both online roles until their browsers reconnect.
  setServerFreePresence(freeServer, "captain", false);
  setServerFreePresence(freeServer, "crew", false);
  return {
    id: String(saved.id),
    mode: "free",
    captain: null,
    crew: null,
    createdAt: Number(saved.createdAt) || now,
    pending: {captain: [], crew: []},
    lastSeen: {captain: 0, crew: 0},
    emptySince: Number(saved.emptySince) || now,
    freeServer,
  };
}

export class Lobby extends MemoryLobby {
  constructor(state, env) {
    super(state, env);
    this.persistentState = state;
    this.persistedRoomIds = new Set();
    this.persistenceDirty = false;
    this.persistencePromise = null;
    this.nextPersistAt = 0;

    state.blockConcurrencyWhile(async () => {
      try {
        const entries = await state.storage.list({prefix: ROOM_STORAGE_PREFIX});
        const now = Date.now();
        const invalidKeys = [];
        for (const [key, saved] of entries) {
          const room = restoredRoom(saved, now);
          if (!room) {
            invalidKeys.push(key);
            continue;
          }
          this.rooms.set(room.id, room);
          this.persistedRoomIds.add(room.id);
        }
        for (const key of invalidKeys) await state.storage.delete(key);
      } catch (error) {
        // A storage read failure must not make the whole game unreachable.
        console.error("Unable to restore free-roam rooms", error);
      }
    });
  }

  storageKey(roomId) {
    return `${ROOM_STORAGE_PREFIX}${roomId}`;
  }

  async deleteSavedRoom(roomId) {
    const id = String(roomId || "").trim().slice(0, 32);
    if (!id) return false;
    const room = this.rooms.get(id);
    if (room?.mode === "free") {
      for (const role of ROOM_ROLES) {
        const socket = room[role];
        if (!socket) continue;
        this.clients.delete(socket);
        try { socket.close(4105, "saved-world-deleted"); } catch (_) {}
      }
      this.rooms.delete(id);
    }
    this.persistedRoomIds.delete(id);
    await this.persistentState.storage.delete(this.storageKey(id));
    return Boolean(room);
  }

  async flushPersistence() {
    this.persistenceDirty = false;
    const now = Date.now();
    const current = new Map();
    for (const room of this.rooms.values()) {
      if (room.mode !== "free" || !room.freeServer?.world) continue;
      current.set(room.id, storedRoom(room, now));
    }

    try {
      for (const [roomId, saved] of current) {
        await this.persistentState.storage.put(this.storageKey(roomId), saved);
      }
      for (const roomId of this.persistedRoomIds) {
        if (!current.has(roomId)) await this.persistentState.storage.delete(this.storageKey(roomId));
      }
      this.persistedRoomIds = new Set(current.keys());
    } catch (error) {
      this.persistenceDirty = true;
      console.error("Unable to persist free-roam rooms", error);
    }
  }

  queuePersistence(force = false) {
    this.persistenceDirty = true;
    const now = Date.now();
    if (!force && now < this.nextPersistAt) return;
    this.nextPersistAt = now + PERSIST_INTERVAL_MS;
    if (this.persistencePromise) return;

    const pending = this.flushPersistence()
      .catch(error => console.error("Free-roam persistence failed", error))
      .finally(() => {
        this.persistencePromise = null;
        if (this.persistenceDirty && Date.now() >= this.nextPersistAt) this.queuePersistence(true);
      });
    this.persistencePromise = pending;
    this.persistentState.waitUntil(pending);
  }

  tickFreeRooms(now = Date.now()) {
    const result = super.tickFreeRooms(now);
    this.queuePersistence(false);
    return result;
  }

  replaceFreeRoleConnection(room, role) {
    const replaced = super.replaceFreeRoleConnection(room, role);
    if (replaced) this.queuePersistence(true);
    return replaced;
  }

  removeRole(room, role, notify = true) {
    super.removeRole(room, role, notify);
    this.queuePersistence(true);
  }

  pruneRooms(now = Date.now()) {
    let changed = false;
    for (const room of this.rooms.values()) {
      room.lastSeen ||= {captain: room.createdAt || now, crew: room.createdAt || now};
      for (const role of ROOM_ROLES) {
        const socket = room[role];
        if (!socket) continue;
        const lastSeen = Number(room.lastSeen[role]) || Number(room.createdAt) || now;
        const expired = now - lastSeen > 18_000;
        const freeRoomWithLiveSocket = room.mode === "free" && socketLooksOpen(socket);
        if (!socketLooksOpen(socket) || (expired && !freeRoomWithLiveSocket)) {
          this.removeRole(room, role, true);
          changed = true;
        }
      }
      if (!room.captain && !room.crew) {
        // An empty free world is a saved game, not garbage. It remains hidden
        // from the public waiting-room list and survives until its owner presses
        // “Create new world”, which calls the explicit deletion endpoint below.
        if (!room.emptySince) {
          room.emptySince = now;
          changed = true;
        }
      } else if (room.emptySince) {
        room.emptySince = 0;
        changed = true;
      }
    }
    this.stopFreeTickerIfIdle();
    if (changed) this.queuePersistence(true);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/saved-world") {
      const roomId = String(url.searchParams.get("room") || "").trim();
      if (request.method === "DELETE") {
        const existed = await this.deleteSavedRoom(roomId);
        return json({ok: true, room: roomId, deleted: existed});
      }
      if (request.method === "GET") {
        const room = this.rooms.get(roomId);
        return json({
          room: roomId,
          exists: Boolean(room?.mode === "free" && room.freeServer?.world),
          online: Boolean(room?.captain || room?.crew),
        });
      }
      return json({error: "Method not allowed"}, 405);
    }

    const response = await super.fetch(request);
    if (url.pathname === "/api/connect") this.queuePersistence(true);
    return response;
  }
}

export default baseWorker;
