import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Lobby} from "../src/worker-persistent.js";
import {createServerFreeRoom} from "../src/free-roam-server.js";

const ROOM_PREFIX = "free-room-v1:";
const PRIMARY_KEY = "free-primary-room-v1";

class FakeStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  async list({prefix = ""} = {}) {
    return new Map([...this.values].filter(([key]) => String(key).startsWith(prefix)));
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    return this.values.delete(key);
  }
}

function fakeState(storage) {
  const state = {
    storage,
    ready: Promise.resolve(),
    pending: [],
    blockConcurrencyWhile(callback) {
      this.ready = Promise.resolve().then(callback);
      return this.ready;
    },
    waitUntil(promise) {
      this.pending.push(Promise.resolve(promise));
    },
  };
  return state;
}

function savedRoom(id, savedAt) {
  return {
    version: 1,
    savedAt,
    id,
    mode: "free",
    createdAt: savedAt,
    lastSeen: {captain: 0, crew: 0},
    emptySince: savedAt,
    freeServer: createServerFreeRoom(savedAt),
  };
}

function liveRoom(id, now = Date.now()) {
  return {
    id,
    mode: "free",
    captain: null,
    crew: null,
    createdAt: now,
    pending: {captain: [], crew: []},
    lastSeen: {captain: 0, crew: 0},
    emptySince: now,
    freeServer: createServerFreeRoom(now),
  };
}

test("startup physically collapses legacy saves to one newest world", async () => {
  const storage = new FakeStorage([
    [`${ROOM_PREFIX}FREE-OLD`, savedRoom("FREE-OLD", 100)],
    [`${ROOM_PREFIX}FREE-NEW`, savedRoom("FREE-NEW", 200)],
  ]);
  const state = fakeState(storage);
  const lobby = new Lobby(state, {});
  await state.ready;

  assert.equal(lobby.primarySavedRoomId, "FREE-NEW");
  assert.deepEqual([...lobby.rooms.keys()], ["FREE-NEW"]);
  assert.equal(storage.values.has(`${ROOM_PREFIX}FREE-OLD`), false);
  assert.equal(storage.values.has(`${ROOM_PREFIX}FREE-NEW`), true);
  assert.equal(storage.values.get(PRIMARY_KEY), "FREE-NEW");
});

test("many live rooms may exist but only the first can become durable", async () => {
  const storage = new FakeStorage();
  const state = fakeState(storage);
  const lobby = new Lobby(state, {});
  await state.ready;

  lobby.rooms.set("FREE-A", liveRoom("FREE-A"));
  lobby.rooms.set("FREE-B", liveRoom("FREE-B"));

  assert.equal(lobby.markRoomDirty("FREE-A"), true);
  assert.equal(lobby.markRoomDirty("FREE-B"), false);
  await lobby.flushPersistence();

  assert.deepEqual([...lobby.rooms.keys()], ["FREE-A", "FREE-B"]);
  assert.equal(lobby.primarySavedRoomId, "FREE-A");
  assert.equal(storage.values.get(PRIMARY_KEY), "FREE-A");
  assert.equal(storage.values.has(`${ROOM_PREFIX}FREE-A`), true);
  assert.equal(storage.values.has(`${ROOM_PREFIX}FREE-B`), false);
});

test("nearest entry and explicit resume are separate paths", async () => {
  const [client, worker, html] = await Promise.all([
    readFile(new URL("../public/src/free-roam-saved-world-v1.js", import.meta.url), "utf8"),
    readFile(new URL("../src/worker-persistent.js", import.meta.url), "utf8"),
    readFile(new URL("../public/free-roam.html", import.meta.url), "utf8"),
  ]);

  assert.match(client, /join\.textContent = "Войти в ближайший мир"/);
  assert.match(client, /resumeSavedButton/);
  assert.doesNotMatch(client, /closest\("#joinButton"\)[\s\S]{0,100}pendingSavedJoin = true/);
  assert.doesNotMatch(worker, /routeToPrimaryRoom/);
  assert.match(worker, /if \(!roomId \|\| !this\.claimPrimarySavedRoom\(roomId\)\) return false/);
  assert.match(html, /free-roam-saved-world-v1\.js\?v=2/);
});
