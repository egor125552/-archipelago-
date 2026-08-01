import baseWorker, {Lobby as MemoryLobby} from "./worker.js";
import {
  consumeCompletedTrainingEpisodes,
  finishServerTrainingBattle,
  persistedWorldForServerRoom,
  serializeTrainingEpisode,
  setServerFreePresence,
  setServerTrainingRecording,
  startServerTrainingBattle,
  tickServerFreeRoom,
  trainingRuntimeStatus,
} from "./free-roam-server.js";
import {createStoredZip} from "./training-archive.js";
import {normalizePersistedFreeWorld} from "./world-storage-normalization.js";

const ROOM_STORAGE_PREFIX = "free-room-v1:";
const PRIMARY_ROOM_STORAGE_KEY = "free-primary-room-v1";
const TRAINING_STORAGE_PREFIX = "free-training-v1:";
const ROOM_ROLES = Object.freeze(["captain", "crew"]);
const PERSIST_INTERVAL_MS = 1000;
const TRAINING_CHUNK_CHARACTERS = 72_000;
const MAX_TRAINING_EPISODES = 20;
const MAX_TRAINING_BYTES = 24 * 1024 * 1024;

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
  const {trainingRuntime: _trainingRuntime, ...serverState} = room.freeServer || {};
  const freeServer = cloneValue({
    ...serverState,
    world: persistedWorldForServerRoom(room.freeServer),
  });
  freeServer.world = normalizePersistedFreeWorld(freeServer.world);
  return {
    version: 1,
    savedAt,
    id: room.id,
    mode: room.mode,
    createdAt: room.createdAt,
    lastSeen: {...(room.lastSeen || {})},
    emptySince: Number(room.emptySince) || 0,
    freeServer,
  };
}

function restoredRoom(saved, now = Date.now()) {
  if (!saved || saved.mode !== "free" || !saved.id || !saved.freeServer?.world) return null;
  const freeServer = cloneValue(saved.freeServer);
  freeServer.world = normalizePersistedFreeWorld(freeServer.world);
  freeServer.lastTickAt = now;
  delete freeServer.trainingRuntime;
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

function safeTrainingId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "episode";
}

function splitString(value, size = TRAINING_CHUNK_CHARACTERS) {
  const result = [];
  for (let offset = 0; offset < value.length; offset += size) result.push(value.slice(offset, offset + size));
  return result.length ? result : [""];
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
    this.trainingPersistencePromise = Promise.resolve();

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

        // A temporary deployment allowed each browser to create its own durable
        // save. Keep exactly one physical save, but do not restrict live rooms.
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

  trainingPrefix(roomId) {
    return `${TRAINING_STORAGE_PREFIX}${String(roomId || "").slice(0, 32)}:`;
  }

  trainingManifestKey(roomId) {
    return `${this.trainingPrefix(roomId)}manifest`;
  }

  trainingChunkKey(roomId, episodeId, index) {
    return `${this.trainingPrefix(roomId)}episode:${safeTrainingId(episodeId)}:${index}`;
  }

  async loadTrainingManifest(roomId) {
    const stored = await this.persistentState.storage.get(this.trainingManifestKey(roomId));
    const episodes = Array.isArray(stored?.episodes) ? stored.episodes : [];
    return {
      version: 1,
      room: String(roomId || ""),
      episodes,
      totalBytes: episodes.reduce((sum, episode) => sum + (Number(episode?.bytes) || 0), 0),
    };
  }

  async deleteTrainingEpisode(roomId, episode) {
    const chunkCount = Math.max(0, Math.floor(Number(episode?.chunkCount) || 0));
    for (let index = 0; index < chunkCount; index += 1) {
      await this.persistentState.storage.delete(this.trainingChunkKey(roomId, episode.id, index));
    }
  }

  async persistTrainingEpisodes(roomId, episodes) {
    if (!roomId || !episodes?.length) return this.loadTrainingManifest(roomId);
    const manifest = await this.loadTrainingManifest(roomId);
    for (const episode of episodes) {
      const serialized = serializeTrainingEpisode(episode);
      const chunks = splitString(serialized);
      const previous = manifest.episodes.find(item => item.id === episode.id);
      if (previous) {
        await this.deleteTrainingEpisode(roomId, previous);
        manifest.episodes = manifest.episodes.filter(item => item.id !== episode.id);
      }
      for (let index = 0; index < chunks.length; index += 1) {
        await this.persistentState.storage.put(this.trainingChunkKey(roomId, episode.id, index), chunks[index]);
      }
      manifest.episodes.push({
        id: episode.id,
        mode: episode.mode,
        level: episode.level,
        encounterId: episode.encounterId,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        durationSeconds: episode.durationSeconds,
        playerCount: episode.playerCount,
        outcome: episode.outcome,
        frameCount: episode.frameCount,
        truncated: Boolean(episode.truncated),
        chunkCount: chunks.length,
        bytes: new TextEncoder().encode(serialized).length,
      });
    }

    manifest.episodes.sort((left, right) => (Number(left.startedAt) || 0) - (Number(right.startedAt) || 0));
    manifest.totalBytes = manifest.episodes.reduce((sum, episode) => sum + (Number(episode.bytes) || 0), 0);
    while (manifest.episodes.length > MAX_TRAINING_EPISODES || manifest.totalBytes > MAX_TRAINING_BYTES) {
      const removed = manifest.episodes.shift();
      await this.deleteTrainingEpisode(roomId, removed);
      manifest.totalBytes -= Number(removed?.bytes) || 0;
    }
    await this.persistentState.storage.put(this.trainingManifestKey(roomId), manifest);
    return manifest;
  }

  queueTrainingPersistence(roomId, episodes) {
    if (!roomId || !episodes?.length) return this.trainingPersistencePromise;
    const task = this.trainingPersistencePromise
      .catch(() => {})
      .then(() => this.persistTrainingEpisodes(roomId, episodes));
    this.trainingPersistencePromise = task.catch(error => {
      console.error(`Unable to persist training episodes for ${roomId}`, error);
    });
    this.persistentState.waitUntil(this.trainingPersistencePromise);
    return task;
  }

  captureCompletedTrainingEpisodes(room) {
    const episodes = consumeCompletedTrainingEpisodes(room?.freeServer);
    if (episodes.length) this.queueTrainingPersistence(room.id, episodes);
    return episodes;
  }

  async clearTrainingArchive(roomId) {
    const prefix = this.trainingPrefix(roomId);
    const entries = await this.persistentState.storage.list({prefix});
    for (const key of entries.keys()) await this.persistentState.storage.delete(key);
    return {version: 1, room: roomId, episodes: [], totalBytes: 0};
  }

  async readTrainingEpisode(roomId, episode) {
    const chunks = [];
    for (let index = 0; index < Math.max(0, Number(episode.chunkCount) || 0); index += 1) {
      chunks.push(String(await this.persistentState.storage.get(this.trainingChunkKey(roomId, episode.id, index)) || ""));
    }
    return chunks.join("");
  }

  async trainingArchiveResponse(roomId) {
    await this.trainingPersistencePromise.catch(() => {});
    const manifest = await this.loadTrainingManifest(roomId);
    if (!manifest.episodes.length) return json({error: "No recorded battles", room: roomId}, 404);
    const publicManifest = {
      version: 1,
      room: roomId,
      createdAt: Date.now(),
      episodeCount: manifest.episodes.length,
      totalBytes: manifest.totalBytes,
      episodes: manifest.episodes,
    };
    const files = [{name: "manifest.json", data: `${JSON.stringify(publicManifest, null, 2)}\n`}];
    for (let index = 0; index < manifest.episodes.length; index += 1) {
      const episode = manifest.episodes[index];
      const number = String(index + 1).padStart(4, "0");
      files.push({
        name: `battle-${number}-threat-${episode.level}-${safeTrainingId(episode.id)}.jsonl`,
        data: await this.readTrainingEpisode(roomId, episode),
      });
    }
    const zip = createStoredZip(files);
    return new Response(zip, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="echo-ai-training-${safeTrainingId(roomId)}.zip"`,
        "cache-control": "no-store",
        "content-length": String(zip.length),
      },
    });
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
    if (room?.freeServer?.trainingRuntime?.active) {
      finishServerTrainingBattle(room.freeServer, "world-deleted", {restore: false, now: Date.now()});
      const episodes = consumeCompletedTrainingEpisodes(room.freeServer);
      if (episodes.length) await this.queueTrainingPersistence(id, episodes);
    }
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
    for (const roomId of activeRoomIds) {
      const room = this.rooms.get(roomId);
      if (!room) continue;
      this.captureCompletedTrainingEpisodes(room);
      this.markRoomDirty(roomId);
    }
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
    if (!room.captain && !room.crew && room.freeServer?.trainingRuntime?.active) {
      finishServerTrainingBattle(room.freeServer, "disconnected", {restore: true, now: Date.now()});
    }
    this.captureCompletedTrainingEpisodes(room);
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

  trainingRoom(url) {
    const roomId = String(url.searchParams.get("room") || this.primarySavedRoomId || "").trim().slice(0, 32);
    return {roomId, room: roomId ? this.rooms.get(roomId) : null};
  }

  async fetch(request) {
    const url = new URL(request.url);
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

    if (url.pathname.startsWith("/api/training/")) {
      const {roomId, room} = this.trainingRoom(url);
      if (!roomId) return json({error: "Free-roam room is required"}, 400);

      if (url.pathname === "/api/training/start") {
        if (request.method !== "POST") return json({error: "Method not allowed"}, 405);
        if (!room?.freeServer?.world || (!room.captain && !room.crew)) return json({error: "The free-roam room is not online"}, 404);
        let body = {};
        try { body = await request.json(); } catch (_) {}
        const status = startServerTrainingBattle(room.freeServer, body.level, body.record !== false, Date.now());
        const episodes = consumeCompletedTrainingEpisodes(room.freeServer);
        if (episodes.length) await this.queueTrainingPersistence(roomId, episodes);
        this.markRoomDirty(room);
        this.queuePersistence(true);
        this.broadcastFreeState(room, tickServerFreeRoom(room.freeServer, Date.now()));
        return json({ok: true, room: roomId, exactProductionEncounter: true, ...status});
      }

      if (url.pathname === "/api/training/finish") {
        if (request.method !== "POST") return json({error: "Method not allowed"}, 405);
        if (!room?.freeServer?.world) return json({error: "The free-roam room is unavailable"}, 404);
        const status = finishServerTrainingBattle(room.freeServer, "manual", {restore: true, now: Date.now()});
        const episodes = consumeCompletedTrainingEpisodes(room.freeServer);
        if (episodes.length) await this.queueTrainingPersistence(roomId, episodes);
        this.markRoomDirty(room);
        this.queuePersistence(true);
        if (room.captain || room.crew) this.broadcastFreeState(room, tickServerFreeRoom(room.freeServer, Date.now()));
        return json({ok: true, room: roomId, ...status});
      }

      if (url.pathname === "/api/training/recording") {
        if (request.method !== "POST") return json({error: "Method not allowed"}, 405);
        if (!room?.freeServer?.world) return json({error: "The free-roam room is unavailable"}, 404);
        let body = {};
        try { body = await request.json(); } catch (_) {}
        const status = setServerTrainingRecording(room.freeServer, body.enabled === true, Date.now());
        const episodes = consumeCompletedTrainingEpisodes(room.freeServer);
        if (episodes.length) await this.queueTrainingPersistence(roomId, episodes);
        return json({ok: true, room: roomId, ...status});
      }

      if (url.pathname === "/api/training/status") {
        if (request.method !== "GET") return json({error: "Method not allowed"}, 405);
        await this.trainingPersistencePromise.catch(() => {});
        const archive = await this.loadTrainingManifest(roomId);
        return json({
          ok: true,
          room: roomId,
          runtime: room?.freeServer ? trainingRuntimeStatus(room.freeServer) : null,
          archive: {
            episodeCount: archive.episodes.length,
            totalBytes: archive.totalBytes,
            episodes: archive.episodes.map(episode => ({
              id: episode.id,
              mode: episode.mode,
              level: episode.level,
              startedAt: episode.startedAt,
              durationSeconds: episode.durationSeconds,
              outcome: episode.outcome,
              frameCount: episode.frameCount,
              bytes: episode.bytes,
            })),
          },
        });
      }

      if (url.pathname === "/api/training/archive") {
        if (request.method === "GET") return this.trainingArchiveResponse(roomId);
        if (request.method === "DELETE") {
          await this.trainingPersistencePromise.catch(() => {});
          await this.clearTrainingArchive(roomId);
          return json({ok: true, room: roomId, deleted: true});
        }
        return json({error: "Method not allowed"}, 405);
      }

      return json({error: "Training endpoint not found"}, 404);
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
