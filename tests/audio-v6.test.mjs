import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {AudioEngine} from "../public/src/audio-engine-v6.js";

const source = await readFile(new URL("../public/src/audio-engine-v6.js", import.meta.url), "utf8");

test("v6 audio engine module loads", () => {
  assert.equal(typeof AudioEngine, "function");
});

test("recorded ambience, boat, pump, warning and impact sources are configured", () => {
  for (const name of ["seaReal", "motorboatReal", "pumpReal", "warningReal", "hullImpactReal"]) {
    assert.match(source, new RegExp(`${name}:`));
  }
});

test("final mechanical loops do not reactivate the legacy ambience or pump", () => {
  assert.doesNotMatch(source, /ensureLoop\("engineNew"/);
  assert.doesNotMatch(source, /ensureLoop\("pumpNew"/);
  assert.match(source, /ensureLoop\("motorboatReal"/);
  assert.match(source, /ensureLoop\("pumpReal"/);
});

test("scenario and navigation cues remain delegated to the established cue layer", () => {
  for (const cue of ["sonar", "hazard-ping", "turn", "turn-progress", "rope", "rescue-complete", "win"]) {
    assert.match(source, new RegExp(`"${cue}"`));
  }
  assert.match(source, /super\.handle\(\[event\]\)/);
});
