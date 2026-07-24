import test from "node:test";
import assert from "node:assert/strict";

import {
  applyServerFreeInput,
  createServerFreeRoom,
  setServerFreePresence,
  tickServerFreeRoom,
} from "../src/free-roam-server.js";

test("free-roam server continues after first authoritative snapshot and answers sonar", () => {
  const startedAt = 1_000_000;
  const room = createServerFreeRoom(startedAt);

  setServerFreePresence(room, "captain", true);
  const first = tickServerFreeRoom(room, startedAt + 40);
  assert.ok(first?.world, "first authoritative world snapshot must exist");

  const accepted = applyServerFreeInput(room, "captain", {sonar: true}, 1);
  assert.equal(accepted, true, "sonar input must be accepted");

  const second = tickServerFreeRoom(room, startedAt + 80);
  assert.ok(second?.world, "server must keep producing snapshots after player input");
  assert.ok(second.sequence > first.sequence, "state sequence must keep advancing");
  assert.ok(
    second.events.some(event => event?.targets?.includes(0) && (event.type === "sonar" || event.type === "sonar-empty" || event.text)),
    "sonar or objective feedback must reach player one",
  );
});
