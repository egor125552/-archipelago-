import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("Safari loads the updated elite boss audio helper", async () => {
  const quality = await readFile(new URL("../public/src/free-roam-quality-v1.js", import.meta.url), "utf8");
  assert.match(quality, /free-roam-elite-boat-audio-v11\.js\?v=3/);
  assert.doesNotMatch(quality, /free-roam-elite-boat-audio-v11\.js\?v=2/);
});

test("elite boss audio remains a narrow helper driven by authoritative server state", async () => {
  const audio = await readFile(new URL("../public/src/free-roam-elite-boat-audio-v11.js", import.meta.url), "utf8");
  assert.match(audio, /const engine = elite\.engineAudio \|\| \{\}/);
  assert.match(audio, /updateMarauderEngine/);
  assert.match(audio, /engine\.state === "full-power"/);
  assert.match(audio, /engine\.state === "damaged"/);
  assert.match(audio, /case "elite-bomb-bay-opening"/);
  assert.match(audio, /case "elite-bullet-flyby"/);
  assert.doesNotMatch(audio, /freeEliteBossTactics/);
  assert.doesNotMatch(audio, /playerMemory/);
  assert.doesNotMatch(audio, /chooseMovement/);
});
