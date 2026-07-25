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
  freeServer.world.events = [];
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
    this.dirtyRoomIds = new Set();
    this.persistencePromise = null;
    this.persistenceRetryTimer = null;
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

  markRoomDirty(roomOrId) {
    const roomId = typeof roomOrId === "string" ? roomOrId : roomOrId?.id;
    if (roomId) this.dirtyRoomIds.add(String(roomId));
  }

  markConnectedRoomsDirty() {
    for (const room of this.rooms.values()) {
      if (room.mode === "free" && (room.captain || room.crew)) this.markRoomDirty(room);
    }
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
    this.dirtyRoomIds.delete(id);
    await this.persistentState.storage.delete(this.storageKey(id));
    return Boolean(room);
  }

  async flushPersistence() {
    const roomIds = [...this.dirtyRoomIds];
    this.dirtyRoomIds.clear();
    const failed = [];
    const now = Date.now();

    for (const roomId of roomIds) {
      try {
        const room = this.rooms.get(roomId);
        if (room?.mode === "free" && room.freeServer?.world) {
          await this.persistentState.storage.put(this.storageKey(roomId), storedRoom(room, now));
        } else {
          await this.persistentState.storage.delete(this.storageKey(roomId));
        }
      } catch (error) {
        failed.push(roomId);
        console.error(`Unable to persist free-roam room ${roomId}`, error);
      }
    }

    for (const roomId of failed) this.dirtyRoomIds.add(roomId);
  }

  schedulePersistenceRetry() {
    if (this.persistenceRetryTimer || !this.dirtyRoomIds.size) return;
    this.persistenceRetryTimer = setTimeout(() => {
      this.persistenceRetryTimer = null;
      this.queuePersistence(true);
    }, PERSIST_INTERVAL_MS);
    this.persistenceRetryTimer?.unref?.();
  }

  queuePersistence(force = false) {
    if (!this.dirtyRoomIds.size) return;
    const now = Date.now();
    if (this.persistencePromise) return;
    if (!force && now < this.nextPersistAt) return;
    this.nextPersistAt = now + PERSIST_INTERVAL_MS;

    const pending = this.flushPersistence()
      .catch(error => console.error("Free-roam persistence failed", error))
      .finally(() => {
        this.persistencePromise = null;
        if (this.dirtyRoomIds.size) this.schedulePersistenceRetry();
      });
    this.persistencePromise = pending;
    this.persistentState.waitUntil(pending);
  }

  tickFreeRooms(now = Date.now()) {
    const activeRoomIds = [...this.rooms.values()]
      .filter(room => room.mode === "free" && (room.captain || room.crew))
      .map(room => room.id);
    const result = super.tickFreeRooms(now);
    for (const roomId of activeRoomIds) this.markRoomDirty(roomId);
    this.queuePersistence(false);
    return result;
  }

  replaceFreeRoleConnection(room, role) {
    const replaced = super.replaceFreeRoleConnection(room, role);
    if (replaced) {
      this.markRoomDirty(room);
      this.queuePersistence(true);
    }
    return replaced;
  }

  removeRole(room, role, notify = true) {
    super.removeRole(room, role, notify);
    this.markRoomDirty(room);
    this.queuePersistence(true);
  }

  pruneRooms(now = Date.now()) {
    for (const room of this.rooms.values()) {
      let changed = false;
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
      if (changed) this.markRoomDirty(room);
    }
    this.stopFreeTickerIfIdle();
    this.queuePersistence(true);
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
    if (url.pathname === "/api/connect") {
      this.markConnectedRoomsDirty();
      this.queuePersistence(true);
    }
    return response;
  }
}

export default baseWorker;
