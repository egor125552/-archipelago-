import baseWorker, {Lobby as MemoryLobby} from "./worker.js";
import {setServerFreePresence} from "./free-roam-server.js";
import {normalizePersistedFreeWorld} from "./world-storage-normalization.js";

const ROOM_STORAGE_PREFIX = "free-room-v1:";
const PRIMARY_ROOM_STORAGE_KEY = "free-primary-room-v1";
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
    freeServer: (() => {
      const freeServer = cloneValue(room.freeServer);
      freeServer.world = normalizePersistedFreeWorld(freeServer.world);
      return freeServer;
    })(),
  };
}

function restoredRoom(saved, now = Date.now()) {
  if (!saved || saved.mode !== "free" || !saved.id || !saved.freeServer?.world) return null;
  const freeServer = cloneValue(saved.freeServer);
  freeServer.world = normalizePersistedFreeWorld(freeServer.world);
  freeServer.lastTickAt = now;
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
    this.primarySavedRoomId = "";
    this.primaryRoomKeyDirty = false;
    this.dirtyRoomIds = new Set();
    this.persistencePromise = null;
    this.persistenceRetryTimer = null;
    this.nextPersistAt = 0;

    state.blockConcurrencyWhile(async () => {
      try {
        const [entries, storedPrimaryValue] = await Promise.all([
          state.storage.list({prefix: ROOM_STORAGE_PREFIX}),
          state.storage.get(PRIMARY_ROOM_STORAGE_KEY),
        ]);
        const now = Date.now();
        const candidates = [];
        const invalidKeys = [];
        for (const [key, saved] of entries) {
          const room = restoredRoom(saved, now);
          if (!room) {
            invalidKeys.push(key);
            continue;
          }
          candidates.push({key, saved, room});
        }

        const storedPrimary = String(storedPrimaryValue || "");
        candidates.sort((left, right) => (Number(right.saved?.savedAt) || 0) - (Number(left.saved?.savedAt) || 0));
        const selected = candidates.find(candidate => candidate.room.id === storedPrimary) || candidates[0] || null;
        if (selected) {
          this.primarySavedRoomId = selected.room.id;
          this.rooms.set(selected.room.id, selected.room);
          await state.storage.put(PRIMARY_ROOM_STORAGE_KEY, selected.room.id);
        } else {
          await state.storage.delete(PRIMARY_ROOM_STORAGE_KEY);
        }

        for (const candidate of candidates) {
          if (candidate !== selected) invalidKeys.push(candidate.key);
        }
        for (const key of invalidKeys) await state.storage.delete(key);
      } catch (error) {
        console.error("Unable to restore the primary free-roam room", error);
      }
    });
  }

  storageKey(roomId) {
    return `${ROOM_STORAGE_PREFIX}${roomId}`;
  }

  isPrimarySavedRoom(roomId) {
    return Boolean(roomId && String(roomId) === this.primarySavedRoomId);
  }

  claimPrimarySavedRoom(roomId) {
    const id = String(roomId || "").trim().slice(0, 32);
    if (!id) return false;
    if (this.primarySavedRoomId && this.primarySavedRoomId !== id) return false;
    if (!this.primarySavedRoomId) {
      this.primarySavedRoomId = id;
      this.primaryRoomKeyDirty = true;
    }
    return true;
  }

  markRoomDirty(roomOrId) {
    const roomId = typeof roomOrId === "string" ? roomOrId : roomOrId?.id;
    if (!roomId || !this.claimPrimarySavedRoom(roomId)) return false;
    this.dirtyRoomIds.add(String(roomId));
    return true;
  }

  markConnectedRoomsDirty() {
    for (const room of this.rooms.values()) {
      if (room.mode === "free" && (room.captain || room.crew)) this.markRoomDirty(room);
    }
  }

  async deleteSavedRoom(roomId) {
    const id = String(roomId || "").trim().slice(0, 32);
    if (!id) return false;
    if (!this.isPrimarySavedRoom(id)) {
      await this.persistentState.storage.delete(this.storageKey(id));
      return false;
    }

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
    this.primarySavedRoomId = "";
    this.primaryRoomKeyDirty = false;
    await Promise.all([
      this.persistentState.storage.delete(this.storageKey(id)),
      this.persistentState.storage.delete(PRIMARY_ROOM_STORAGE_KEY),
    ]);
    return Boolean(room);
  }

  async flushPersistence() {
    const roomIds = [...this.dirtyRoomIds];
    this.dirtyRoomIds.clear();
    const failed = [];
    const now = Date.now();

    try {
      if (this.primaryRoomKeyDirty) {
        if (this.primarySavedRoomId) await this.persistentState.storage.put(PRIMARY_ROOM_STORAGE_KEY, this.primarySavedRoomId);
        else await this.persistentState.storage.delete(PRIMARY_ROOM_STORAGE_KEY);
        this.primaryRoomKeyDirty = false;
      }
    } catch (error) {
      this.primaryRoomKeyDirty = true;
      console.error("Unable to persist primary free-roam room id", error);
    }

    for (const roomId of roomIds) {
      try {
        if (!this.isPrimarySavedRoom(roomId)) {
          await this.persistentState.storage.delete(this.storageKey(roomId));
          continue;
        }
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
    if (this.persistenceRetryTimer || (!this.dirtyRoomIds.size && !this.primaryRoomKeyDirty)) return;
    this.persistenceRetryTimer = setTimeout(() => {
      this.persistenceRetryTimer = null;
      this.queuePersistence(true);
    }, PERSIST_INTERVAL_MS);
    this.persistenceRetryTimer?.unref?.();
  }

  queuePersistence(force = false) {
    if (!this.dirtyRoomIds.size && !this.primaryRoomKeyDirty) return;
    const now = Date.now();
    if (this.persistencePromise) return;
    if (!force && now < this.nextPersistAt) return;
    this.nextPersistAt = now + PERSIST_INTERVAL_MS;

    const pending = this.flushPersistence()
      .catch(error => console.error("Free-roam persistence failed", error))
      .finally(() => {
        this.persistencePromise = null;
        if (this.dirtyRoomIds.size || this.primaryRoomKeyDirty) this.schedulePersistenceRetry();
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

  routeToPrimaryRoom(request, url) {
    if (
      url.pathname !== "/api/connect"
      || url.searchParams.get("mode") !== "free"
      || url.searchParams.get("room")
      || !this.primarySavedRoomId
    ) return request;

    const primaryRoom = this.rooms.get(this.primarySavedRoomId);
    if (!primaryRoom || (primaryRoom.captain && primaryRoom.crew)) return request;
    const routed = new URL(url);
    routed.searchParams.set("room", this.primarySavedRoomId);
    routed.searchParams.set("role", "auto");
    return new Request(routed.toString(), request);
  }

  async fetch(request) {
    let url = new URL(request.url);
    if (url.pathname === "/api/saved-world") {
      const roomId = String(url.searchParams.get("room") || "").trim();
      if (request.method === "DELETE") {
        const existed = await this.deleteSavedRoom(roomId);
        return json({ok: true, room: roomId, deleted: existed, primaryRoom: this.primarySavedRoomId || null});
      }
      if (request.method === "GET") {
        const primaryRoom = this.primarySavedRoomId ? this.rooms.get(this.primarySavedRoomId) : null;
        const requestedRoom = roomId ? this.rooms.get(roomId) : null;
        const primary = Boolean(roomId && this.isPrimarySavedRoom(roomId));
        return json({
          room: roomId || null,
          primaryRoom: this.primarySavedRoomId || null,
          primary,
          exists: Boolean(primary && requestedRoom?.mode === "free" && requestedRoom.freeServer?.world),
          online: Boolean(primary && (requestedRoom?.captain || requestedRoom?.crew)),
          primaryOnline: Boolean(primaryRoom?.captain || primaryRoom?.crew),
        });
      }
      return json({error: "Method not allowed"}, 405);
    }

    request = this.routeToPrimaryRoom(request, url);
    url = new URL(request.url);
    const response = await super.fetch(request);
    if (url.pathname === "/api/connect") {
      this.markConnectedRoomsDirty();
      this.queuePersistence(true);
    }
    return response;
  }
}

export default baseWorker;
