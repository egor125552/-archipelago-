import test from "node:test";
import assert from "node:assert/strict";

import {normalizeRoomCode, workerSocketUrl} from "../public/src/network.js";

test("Worker WebSocket URL follows the current secure origin", () => {
  assert.equal(
    workerSocketUrl({protocol: "https:", host: "archipelago.example.workers.dev"}, "captain"),
    "wss://archipelago.example.workers.dev/api/connect?role=captain",
  );
  assert.equal(
    workerSocketUrl({protocol: "http:", host: "localhost:8787"}, "crew"),
    "ws://localhost:8787/api/connect?role=crew",
  );
});

test("legacy manual room normalization remains unchanged", () => {
  assert.equal(normalizeRoomCode(" sea-аb12 "), "SEAAB1");
});
