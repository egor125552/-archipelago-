import baseWorker, {Lobby as MemoryLobby} from "./worker.js";
import {setServerFreePresence} from "./free-roam-server.js";

const ROOM_STORAGE_PREFIX = "free-room-v1:";
const ROOM_ROLES = Object.freeze(["captain", "crew"]);
const RECONNECT_GRACE_MS = 30 * 60 * 1000;
const PERSIST_INTERVAL_MS = 1000;

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
  // world, but clear both roles until their browsers reconnect.
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
    emptySince: now,
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
        const expiredKeys = [];
        for (const [key, saved] of entries) {
          const priorEmptySince = Number(saved?.emptySince) || 0;
          if (priorEmptySince && now - priorEmptySince >= RECONNECT_GRACE_MS) {
            expiredKeys.push(key);
            continue;
          }
          const room = restoredRoom(saved, now);
          if (!room) {
            expiredKeys.push(key);
            continue;
          }
          this.rooms.set(room.id, room);
          this.persistedRoomIds.add(room.id);
        }
        for (const key of expiredKeys) await state.storage.delete(key);
      } catch (error) {
        // A storage read failure must not make the whole game unreachable.
        // The client will receive an honest new-world message if no saved room
        // can be recovered, and later writes can heal the persistent cache.
        console.error("Unable to restore free-roam rooms", error);
      }
    });
  }

  storageKey(roomId) {
    return `${ROOM_STORAGE_PREFIX}${roomId}`;
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
        if (!room.emptySince) room.emptySince = now;
        if (room.mode !== "free" || now - room.emptySince >= RECONNECT_GRACE_MS) {
          this.rooms.delete(room.id);
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
    const response = await super.fetch(request);
    const url = new URL(request.url);
    if (url.pathname === "/api/connect") this.queuePersistence(true);
    return response;
  }
}

export default baseWorker;
