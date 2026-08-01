import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  NEURAL_THREAT_MAX,
  NEURAL_THREAT_MIN,
  neuralTrainingStartBody,
  normalizeNeuralThreatLevel,
} from "../public/src/free-roam-neural-test-ui-v1.js";

const source = await readFile(new URL("../public/src/free-roam-neural-test-ui-v1.js", import.meta.url), "utf8");

test("neural threat selector stays inside production levels two through five", () => {
  assert.equal(normalizeNeuralThreatLevel(-100), NEURAL_THREAT_MIN);
  assert.equal(normalizeNeuralThreatLevel(2), 2);
  assert.equal(normalizeNeuralThreatLevel(4.9), 4);
  assert.equal(normalizeNeuralThreatLevel(999), NEURAL_THREAT_MAX);
});

test("neural-only UI sends the explicit nested training request", () => {
  assert.deepEqual(neuralTrainingStartBody(5), {
    level: {level: 5, neuralOnly: true},
    record: true,
  });
});

test("neural test UI can finish and download the recorded battle archive", () => {
  assert.match(source, /id="neuralDownloadBattleButton"/);
  assert.match(source, /Завершить и скачать архив с этим боем/);
  assert.match(source, /\/api\/training\/finish\?room=/);
  assert.match(source, /\/api\/training\/archive\?room=/);
  assert.match(source, /manifest\.json/);
});
