import test from "node:test";
import assert from "node:assert/strict";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";
import {createTargetMenuSpeechQueue} from "../public/src/free-roam-target-menu.js";
import {
  createKeyboardReleaseWatchdog,
  KEYBOARD_INITIAL_STALE_MS,
  KEYBOARD_REPEAT_STALE_MS,
} from "../public/src/free-roam-keyboard-release-watchdog-v1.js";

function actionPulse(room, sequence) {
  applyServerFreeInput(room, "captain", {action: true}, sequence);
  applyServerFreeInput(room, "captain", {action: false}, sequence + 1);
}

test("active legacy combat cannot be paused by entering a spatial location", () => {
  const room = createServerFreeRoom(10_000);
  setServerFreePresence(room, "captain", true);
  const player = room.world.players[0];
  player.mode = "foot";
  player.activeBoat = null;
  player.x = 270;
  player.y = 55;
  room.world.freeContracts.encounterActive = true;

  actionPulse(room, 1);
  const blocked = tickServerFreeRoom(room, 10_040);

  assert.equal(player.spatialLocationId, null);
  assert.ok(blocked.events.some(event => (
    event.type === "location-entry-blocked-combat"
    && event.reason === "legacy-combat-boundary"
  )));

  room.world.freeContracts.encounterActive = false;
  actionPulse(room, 3);
  const entered = tickServerFreeRoom(room, 10_080);

  assert.equal(player.spatialLocationId, "location.spatial.lab");
  assert.ok(entered.events.some(event => event.type === "location-enter"));
});

test("target menu speech serializes every explicit browsing step after one Safari reset", () => {
  const clock = fakeClock();
  const spoken = [];
  let cancelCount = 0;
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const synth = {
    getVoices: () => [{lang: "ru-RU", name: "Milena", voiceURI: "Milena"}],
    resume() {},
    cancel() { cancelCount += 1; },
    speak(utterance) { spoken.push(utterance); },
  };
  const queue = createTargetMenuSpeechQueue({
    synth,
    Utterance: FakeUtterance,
    resetDelayMs: 90,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  assert.equal(queue.resetAndSpeak("Цель один"), true);
  assert.equal(queue.enqueue("Цель два"), true);
  assert.equal(queue.enqueue("Цель три"), true);
  assert.equal(cancelCount, 1);
  assert.equal(spoken.length, 0, "Safari reset window must elapse before first speak");

  clock.advance(90);
  assert.deepEqual(spoken.map(item => item.text), ["Цель один"]);
  spoken[0].onend();
  assert.deepEqual(spoken.map(item => item.text), ["Цель один", "Цель два"]);
  spoken[1].onend();
  assert.deepEqual(spoken.map(item => item.text), ["Цель один", "Цель два", "Цель три"]);
  assert.equal(cancelCount, 1, "cycling targets must not cancel an earlier target phrase");
});

function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, {at: time + delay, callback});
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = time + ms;
      while (true) {
        const ready = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!ready) break;
        const [id, timer] = ready;
        timers.delete(id);
        time = timer.at;
        timer.callback();
      }
      time = target;
    },
  };
}

test("keyboard watchdog releases a Mac Safari arrow when keyup disappears", () => {
  const clock = fakeClock();
  const releases = [];
  const watchdog = createKeyboardReleaseWatchdog({
    release: (code, reason) => releases.push({code, reason}),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fallbackEnabled: true,
  });

  watchdog.keyDown("ArrowRight");
  clock.advance(KEYBOARD_INITIAL_STALE_MS - 1);
  assert.equal(releases.length, 0);
  clock.advance(1);
  assert.deepEqual(releases, [{code: "ArrowRight", reason: "keyup-missing"}]);
});

test("keyboard repeat refresh keeps a held arrow alive, then releases after repeats vanish", () => {
  const clock = fakeClock();
  const releases = [];
  const watchdog = createKeyboardReleaseWatchdog({
    release: (code, reason) => releases.push({code, reason}),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fallbackEnabled: true,
  });

  watchdog.keyDown("ArrowDown");
  clock.advance(400);
  watchdog.keyDown("ArrowDown", {repeat: true});
  clock.advance(KEYBOARD_REPEAT_STALE_MS - 100);
  watchdog.keyDown("ArrowDown", {repeat: true});
  clock.advance(KEYBOARD_REPEAT_STALE_MS - 1);
  assert.equal(releases.length, 0);
  clock.advance(1);
  assert.deepEqual(releases, [{code: "ArrowDown", reason: "repeat-stalled"}]);
});

test("real keyup cancels keyboard watchdog release", () => {
  const clock = fakeClock();
  const releases = [];
  const watchdog = createKeyboardReleaseWatchdog({
    release: (code, reason) => releases.push({code, reason}),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fallbackEnabled: true,
  });

  watchdog.keyDown("ArrowLeft");
  clock.advance(300);
  watchdog.keyUp("ArrowLeft");
  clock.advance(KEYBOARD_INITIAL_STALE_MS * 2);
  assert.deepEqual(releases, []);
});
