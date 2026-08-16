"use strict";

const reverbBuses = new WeakMap();

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function finite(value, field, fallback = null) {
  if (value == null && fallback != null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${field} must be finite`);
  return number;
}

export function normalizeSpatialAcousticModel(value, field = "spatialAcoustics") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return Object.freeze({
    gain: clamp(finite(value.gain, `${field}.gain`, 1), 0, 1),
    lowpassHz: Math.max(120, finite(value.lowpassHz, `${field}.lowpassHz`, 20000)),
    reverb: clamp(finite(value.reverb, `${field}.reverb`, 0), 0, 1),
    transmission: clamp(finite(value.transmission, `${field}.transmission`, 1), 0, 1),
  });
}

export function spatialAudioMix(value, {gain = 1, lowpass = 20000, reverbScale = 0.42} = {}) {
  const model = normalizeSpatialAcousticModel(value);
  const baseGain = Math.max(0, finite(gain, "gain"));
  const baseLowpass = Math.max(120, finite(lowpass, "lowpass"));
  const wetFraction = clamp(model.reverb * Math.max(0, finite(reverbScale, "reverbScale")), 0, 0.72);
  const totalGain = baseGain * model.gain;
  return Object.freeze({
    gain: totalGain,
    lowpassHz: Math.min(baseLowpass, model.lowpassHz),
    dryGain: totalGain * (1 - wetFraction),
    wetGain: totalGain * wetFraction,
    reverb: model.reverb,
    transmission: model.transmission,
  });
}

function createImpulse(ctx) {
  const seconds = 1.35;
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      const progress = index / length;
      const envelope = Math.pow(1 - progress, 2.7);
      data[index] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return impulse;
}

function ensureReverbBus(audioEngine) {
  let bus = reverbBuses.get(audioEngine);
  if (bus) return bus;
  const {ctx, master} = audioEngine;
  const convolver = ctx.createConvolver();
  const output = ctx.createGain();
  convolver.buffer = createImpulse(ctx);
  output.gain.value = 1;
  convolver.connect(output).connect(master);
  bus = Object.freeze({convolver, output});
  reverbBuses.set(audioEngine, bus);
  return bus;
}

export function createSpatialAcousticChain(audioEngine, modelValue, {gain = 1, pan = 0, lowpass = 20000} = {}) {
  if (!audioEngine?.ctx || !audioEngine?.master) throw new TypeError("audioEngine must already be initialized and expose ctx/master");
  const mix = spatialAudioMix(modelValue, {gain, lowpass});
  const ctx = audioEngine.ctx;
  const filter = ctx.createBiquadFilter();
  const panner = ctx.createStereoPanner();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  filter.type = "lowpass";
  filter.frequency.value = mix.lowpassHz;
  panner.pan.value = clamp(pan, -1, 1);
  dry.gain.value = mix.dryGain;
  wet.gain.value = mix.wetGain;

  filter.connect(panner);
  panner.connect(dry).connect(audioEngine.master);
  if (mix.wetGain > 0) {
    const bus = ensureReverbBus(audioEngine);
    panner.connect(wet).connect(bus.convolver);
  }

  return Object.freeze({input: filter, filter, panner, dry, wet, mix});
}

export function playSpatialTone(audioEngine, modelValue, {
  frequency = 330,
  duration = 0.55,
  gain = 0.18,
  pan = 0,
  lowpass = 20000,
} = {}) {
  if (!audioEngine?.enabled) return null;
  const ctx = audioEngine?.ctx;
  if (!ctx || !audioEngine.master) throw new TypeError("audioEngine must be initialized before spatial playback");
  const oscillator = ctx.createOscillator();
  const chain = createSpatialAcousticChain(audioEngine, modelValue, {gain, pan, lowpass});
  const now = ctx.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(Math.max(20, finite(frequency, "frequency")), now);
  oscillator.connect(chain.input);
  oscillator.start(now);
  oscillator.stop(now + Math.max(0.03, finite(duration, "duration")));
  return Object.freeze({oscillator, chain});
}
