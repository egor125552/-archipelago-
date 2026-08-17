import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {describeNearbySpatialEntry} from "../public/src/spatial/spatial-accessibility.js";

test("spatial transition prompt avoids broken Russian case after a colon", () => {
  const text = describeNearbySpatialEntry({
    type:"connection",
    kind:"stairs",
    label:"Лестница между этажами",
    metres:3,
    available:true,
    elevationDelta:-3,
    destinationLabel:"Технический подвал",
  }, {actionReady:true});
  assert.equal(text, "Лестница между этажами: 3 метра. Нажми действие, чтобы спуститься. Следующий уровень: Технический подвал.");
  assert.doesNotMatch(text, /спуститься:\s/);
});

test("spatial location entry wording does not force a location name into the wrong case", () => {
  const source = fs.readFileSync(new URL("../public/src/spatial/spatial-free-roam-integration.js", import.meta.url), "utf8");
  assert.match(source, /Ты вошёл в локацию «\$\{this\.compiled\.presentation\.label\}»/);
  assert.match(source, /До входа в локацию «\$\{nearest\.compiled\.presentation\.label\}»/);
  assert.doesNotMatch(source, /Вход в \$\{nearest\.compiled\.presentation\.label\}/);
});

test("fall speech shares metre grammar and exposes coordinates for the positional locator", () => {
  const source = fs.readFileSync(new URL("../public/src/spatial/spatial-free-roam-gameplay.js", import.meta.url), "utf8");
  assert.match(source, /formatSpatialMetres/);
  assert.match(source, /location-fall-edge/);
  assert.match(source, /x:best\.position\.x,y:best\.position\.y,z:best\.position\.z/);
  assert.doesNotMatch(source, /примерно \$\{Math\.max\(1,Math\.round\(best\.metres\)\)\} метров/);
});

test("existing free-roam audio handles spatial nearby and edge events as positional pips", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-audio-v3.js", import.meta.url), "utf8");
  assert.match(source, /location-nearby/);
  assert.match(source, /location-fall-edge/);
  assert.match(source, /relativeMovementPan\(this\.listenerPoint, event\)/);
  assert.match(source, /playLocationLocator/);
});
