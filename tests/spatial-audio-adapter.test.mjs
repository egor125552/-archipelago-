import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  createSpatialAcousticChain,
  normalizeSpatialAcousticModel,
  playSpatialTone,
  spatialAudioMix,
} from "../public/src/spatial/spatial-audio-adapter.js";

class Param {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
}

class Node {
  constructor(name) { this.name = name; this.connections = []; }
  connect(node) { this.connections.push(node); return node; }
}

function fakeEngine() {
  const master = new Node("master");
  const ctx = {
    currentTime: 2,
    sampleRate: 100,
    createGain() { const node = new Node("gain"); node.gain = new Param(); return node; },
    createBiquadFilter() { const node = new Node("filter"); node.frequency = new Param(); return node; },
    createStereoPanner() { const node = new Node("panner"); node.pan = new Param(); return node; },
    createConvolver() { const node = new Node("convolver"); node.buffer = null; return node; },
    createBuffer(channels, length) {
      const data = Array.from({length: channels}, () => new Float32Array(length));
      return {numberOfChannels: channels, getChannelData(index) { return data[index]; }};
    },
    createOscillator() {
      const node = new Node("oscillator");
      node.frequency = new Param();
      node.startAt = null;
      node.stopAt = null;
      node.start = at => { node.startAt = at; };
      node.stop = at => { node.stopAt = at; };
      return node;
    },
  };
  return {ctx, master, enabled: true};
}

test("spatial acoustic mix combines location attenuation with an existing sound instead of replacing its settings", () => {
  const mix = spatialAudioMix({gain:0.5,lowpassHz:4200,reverb:0.4,transmission:0.6},{gain:0.8,lowpass:7000});
  assert.equal(mix.gain,0.4);
  assert.equal(mix.lowpassHz,4200);
  assert.ok(mix.dryGain > mix.wetGain);
  assert.equal(Math.round((mix.dryGain + mix.wetGain) * 1000) / 1000,0.4);
});

test("normalized model clamps unsafe acoustic values", () => {
  assert.deepEqual(normalizeSpatialAcousticModel({gain:2,lowpassHz:40,reverb:3,transmission:-1}),{
    gain:1,lowpassHz:120,reverb:1,transmission:0,
  });
});

test("spatial chain uses the already initialized engine master and never needs a destination of its own", () => {
  const engine = fakeEngine();
  const chain = createSpatialAcousticChain(engine,{gain:0.8,lowpassHz:5000,reverb:0.5,transmission:0.8},{gain:0.4,pan:0.3});
  assert.equal(chain.filter.frequency.value,5000);
  assert.equal(chain.panner.pan.value,0.3);
  assert.ok(chain.dry.connections.includes(engine.master));
  assert.ok(chain.wet.connections.some(node => node.name === "convolver"));
});

test("audible probe starts a source on the same engine graph", () => {
  const engine = fakeEngine();
  const result = playSpatialTone(engine,{gain:1,lowpassHz:8000,reverb:0.2,transmission:1},{frequency:440,duration:0.4});
  assert.equal(result.oscillator.startAt,2);
  assert.equal(result.oscillator.stopAt,2.4);
  assert.equal(result.oscillator.connections[0],result.chain.input);
});

test("adapter source itself does not create AudioContext or connect to browser destination", () => {
  const source = fs.readFileSync(new URL("../public/src/spatial/spatial-audio-adapter.js", import.meta.url),"utf8");
  assert.doesNotMatch(source,/new\s+(?:AudioContext|webkitAudioContext)\s*\(/);
  assert.doesNotMatch(source,/\.destination\b/);
});
