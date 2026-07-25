import test from "node:test";
import assert from "node:assert/strict";
import {
  localPredictionLeadSeconds,
  predictLocalWorldAhead,
  reconcileLocalPrediction,
} from "../public/src/free-roam-client-prediction.js";

test("prediction lead uses half the measured round trip and stays bounded", () => {
  assert.equal(localPredictionLeadSeconds({networkRttMs: 240}), 0.12);
  assert.equal(localPredictionLeadSeconds({inputReceiptMs: 400}), 0.18);
  assert.equal(localPredictionLeadSeconds({}), 0);
});

test("high-latency foot reconciliation avoids a large backwards correction", () => {
  const previous = {players: [{mode: "foot", x: 100, y: 98, heading: 0}], boats: []};
  const next = {players: [{mode: "foot", x: 100, y: 100, heading: 0}], boats: []};
  predictLocalWorldAhead(next, 0, {up: true}, 0.12);
  const result = reconcileLocalPrediction(previous, next, 0, {
    input: {up: true},
    networkRttMs: 240,
  });
  assert.ok(result.players[0].y < 98.3, `unexpected rollback to ${result.players[0].y}`);
  assert.ok(result.players[0].y >= 98, "prediction must not jump ahead of the previous rendered point");
});

test("large person disagreements still snap to the authoritative world", () => {
  const previous = {players: [{mode: "swim", x: 100, y: 90, heading: 0}], boats: []};
  const next = {players: [{mode: "swim", x: 100, y: 100, heading: 0}], boats: []};
  const result = reconcileLocalPrediction(previous, next, 0, {
    input: {up: true},
    networkRttMs: 260,
  });
  assert.equal(result.players[0].y, 100);
});
