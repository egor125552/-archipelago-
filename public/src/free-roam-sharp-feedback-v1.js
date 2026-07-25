"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {CARGO_ACTION_RANGE} from "./free-roam-cargo-rules.js?v=32";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
const cargoEvents = new Set(["cargo-pickup", "cargo-stowed", "cargo-transfer"]);

export function likelyCargoAction(world, playerIndex) {
  const player = world?.players?.[playerIndex];
  if (!player?.combat?.alive) return false;
  if (player.combat.carriedCrate) return true;

  const point = ["boat", "roof"].includes(player.mode)
    ? world?.boats?.[player.activeBoat] || player
    : player;
  const nearbyCrate = (world?.freeActivities?.crates || []).some(crate => (
    crate?.state === "world" && distance(point, crate) <= CARGO_ACTION_RANGE
  ));
  if (nearbyCrate) return true;

  if (["boat", "roof"].includes(player.mode)) {
    return Boolean(world?.boats?.[player.activeBoat]?.cargo?.length);
  }
  return (world?.boats || []).some(boat => (
    !boat?.sunk && (boat.cargo || []).length && distance(player, boat) <= 8.5
  ));
}

function installSharpFeedback() {
  const prototype = FreeRoamAudio.prototype;
  if (prototype.__sharpFeedbackInstalled) return;
  Object.defineProperty(prototype, "__sharpFeedbackInstalled", {value: true});

  const originalInit = prototype.init;
  const originalSetupInjuryReverb = prototype.setupInjuryReverb;
  const originalCommandCue = prototype.playLocalCommandCue;
  const originalHandleFreeEvent = prototype.handleFreeEvent;

  prototype.setupSharpFeedback = function setupSharpFeedback() {
    if (!this.ctx || !this.compressor || this.sharpTransientBus) return;
    this.sharpTransientBus = this.ctx.createGain();
    this.sharpTransientBus.gain.value = 0.96;
    // Decisive action transients bypass the injury low-pass and reverb. The
    // ambience and ongoing injury effect stay on the ordinary master path.
    this.sharpTransientBus.connect(this.compressor);
  };

  prototype.setupInjuryReverb = function setupInjuryReverbWithSharpBus(...args) {
    const result = originalSetupInjuryReverb?.apply(this, args);
    this.setupSharpFeedback();
    return result;
  };

  prototype.init = async function initWithSharpFeedback(...args) {
    const result = await originalInit.apply(this, args);
    this.setupSharpFeedback();
    globalThis.__freeRoamSharpAudio = this;
    return result;
  };

  prototype.playSharpBuffer = function playSharpBuffer(name, {
    gain = 0.25,
    pan = 0,
    rate = 1,
    highpass = 35,
    lowpass = 15_500,
    delay = 0,
    offset = 0,
    duration = null,
  } = {}) {
    this.setupSharpFeedback();
    const buffer = this.buffers?.get(name);
    if (!this.ctx || !this.sharpTransientBus || !buffer) return null;

    const source = this.ctx.createBufferSource();
    const high = this.ctx.createBiquadFilter();
    const low = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();
    const output = this.ctx.createGain();
    const startAt = this.ctx.currentTime + Math.max(0, Number(delay) || 0);

    source.buffer = buffer;
    source.playbackRate.value = clamp(Number(rate) || 1, 0.35, 2.5);
    high.type = "highpass";
    high.frequency.value = clamp(Number(highpass) || 35, 10, 8_000);
    low.type = "lowpass";
    low.frequency.value = clamp(Number(lowpass) || 15_500, 250, 20_000);
    panner.pan.value = clamp(Number(pan) || 0, -1, 1);
    output.gain.setValueAtTime(0.0001, startAt);
    output.gain.exponentialRampToValueAtTime(Math.max(0.0001, Number(gain) || 0.25), startAt + 0.003);

    source.connect(high).connect(low).connect(panner).connect(output).connect(this.sharpTransientBus);
    if (Number.isFinite(duration) && duration > 0) source.start(startAt, Math.max(0, Number(offset) || 0), duration);
    else source.start(startAt, Math.max(0, Number(offset) || 0));
    return source;
  };

  prototype.playSharpClick = function playSharpClick({frequency = 180, gain = 0.08, duration = 0.055, pan = 0, delay = 0} = {}) {
    this.setupSharpFeedback();
    if (!this.ctx || !this.sharpTransientBus) return null;
    const oscillator = this.ctx.createOscillator();
    const panner = this.ctx.createStereoPanner();
    const output = this.ctx.createGain();
    const startAt = this.ctx.currentTime + Math.max(0, Number(delay) || 0);
    const endAt = startAt + Math.max(0.025, Number(duration) || 0.055);
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(clamp(Number(frequency) || 180, 45, 4_000), startAt);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(45, (Number(frequency) || 180) * 0.62), endAt);
    panner.pan.value = clamp(Number(pan) || 0, -1, 1);
    output.gain.setValueAtTime(0.0001, startAt);
    output.gain.exponentialRampToValueAtTime(Math.max(0.0001, Number(gain) || 0.08), startAt + 0.002);
    output.gain.exponentialRampToValueAtTime(0.0001, endAt);
    oscillator.connect(panner).connect(output).connect(this.sharpTransientBus);
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.01);
    return oscillator;
  };

  prototype.playImmediateAction = function playImmediateAction(kind, details = {}) {
    if (!this.ctx) return false;
    this.setupSharpFeedback();
    const now = this.ctx.currentTime;
    this._sharpActionAt ||= {};
    if (now - (this._sharpActionAt[kind] || -999) < 0.065) return true;
    this._sharpActionAt[kind] = now;

    if (kind === "jump") {
      this.localSharpJumpUntil = now + 1.4;
      const mode = details.mode || this.listenerPoint?.mode || "foot";
      if (mode === "swim") {
        const water = this.buffers.has("waterSide") ? "waterSide" : "swimImpactV25";
        this.playSharpBuffer(water, {gain: 0.38, rate: 1.1, highpass: 220, lowpass: 13_500, duration: 0.24});
      } else {
        const step = this.nextFootstep?.();
        if (step) this.playSharpBuffer(step, {gain: mode === "roof" ? 0.37 : 0.33, rate: mode === "roof" ? 1.08 : 1.2, highpass: 80, lowpass: 15_500, duration: 0.23});
        if (mode === "roof" && this.buffers.has("hullCreak")) {
          this.playSharpBuffer("hullCreak", {gain: 0.22, rate: 1.2, highpass: 120, lowpass: 9_500, duration: 0.2});
        } else if (this.buffers.has("swingLight")) {
          this.playSharpBuffer("swingLight", {gain: 0.13, rate: 1.38, highpass: 650, lowpass: 16_000, duration: 0.14});
        }
      }
      this.playSharpClick({frequency: 155, gain: 0.065, duration: 0.045});
      return true;
    }

    if (kind === "brake") {
      if (this.buffers.has("hullCreak")) this.playSharpBuffer("hullCreak", {gain: 0.25, rate: 0.86, highpass: 70, lowpass: 8_200, duration: 0.24});
      this.playSharpClick({frequency: 92, gain: 0.11, duration: 0.075});
      return true;
    }

    if (kind === "attack") {
      const weapon = details.weapon || "fists";
      this.localSharpAttackUntil = now + 1.35;
      if (weapon === "automatic") return false;
      if (weapon === "pistol") {
        this.localSharpGunUntil = now + 1.25;
        const shot = this.buffers.has("pistolShot") ? "pistolShot" : "automaticShot";
        this.playSharpBuffer(shot, {gain: 0.78, rate: this.buffers.has("pistolShot") ? 1 : 0.76, highpass: 90, lowpass: 17_500, duration: 0.42});
        this.playSharpClick({frequency: 105, gain: 0.12, duration: 0.05});
        return true;
      }
      const swing = weapon === "knife" && this.buffers.has("knife1") ? "knife1" : "swingLight";
      if (this.buffers.has(swing)) this.playSharpBuffer(swing, {gain: weapon === "knife" ? 0.42 : 0.34, rate: weapon === "knife" ? 1.08 : 1.16, highpass: 320, lowpass: 16_000, duration: 0.28});
      this.playSharpClick({frequency: weapon === "knife" ? 290 : 190, gain: 0.075, duration: 0.04});
      return true;
    }

    if (kind === "cargo") {
      this.localSharpCargoUntil = now + 1.7;
      if (this.buffers.has("repair")) this.playSharpBuffer("repair", {gain: 0.34, rate: 1.18, highpass: 260, lowpass: 12_500, offset: 0.02, duration: 0.18});
      if (this.buffers.has("hullCreak")) this.playSharpBuffer("hullCreak", {gain: 0.18, rate: 1.32, highpass: 180, lowpass: 8_500, delay: 0.025, duration: 0.15});
      this.playSharpClick({frequency: 420, gain: 0.08, duration: 0.035});
      return true;
    }
    return false;
  };

  prototype.playSharpCombatImpact = function playSharpCombatImpact(event, playerIndex) {
    const spatial = event.weapon === "automatic" || event.weapon === "pistol"
      ? this.eventPanAndGain(event, 420)
      : this.eventPanAndGain(event, 105);
    const localTarget = event.targetPlayer === playerIndex;
    const pan = localTarget ? 0 : spatial.pan;
    const gain = spatial.gain * (localTarget ? 1 : 0.78);

    if (event.weapon === "knife") {
      const name = this.nextSound?.("knife", 3) || "knife1";
      this.playSharpBuffer(name, {pan, gain: 0.56 * gain, rate: event.heavy ? 0.9 : 1.05, highpass: 170, lowpass: 15_500, duration: 0.38});
    } else if (["automatic", "pistol"].includes(event.weapon)) {
      this.playSharpBuffer("gunHit", {pan, gain: (event.weapon === "pistol" ? 0.78 : 0.9) * gain, highpass: 240, lowpass: 16_000, duration: 0.25});
    } else {
      const name = event.heavy ? "punchHeavy" : this.nextSound?.("punch", 3) || "punch1";
      this.playSharpBuffer(name, {pan, gain: (event.heavy ? 0.67 : 0.55) * gain, rate: event.heavy ? 0.94 : 1.04, highpass: 75, lowpass: 14_500, duration: 0.34});
    }
    this.playSharpClick({pan, frequency: localTarget ? 88 : 145, gain: (localTarget ? 0.13 : 0.08) * Math.max(0.35, spatial.gain), duration: 0.055});
    if (localTarget && this.buffers.has("hitPlayer")) {
      this.playSharpBuffer("hitPlayer", {gain: event.weapon === "automatic" ? 0.5 : 0.38, pan: 0, highpass: 65, lowpass: 12_500, duration: 0.3});
    }
  };

  prototype.playCombatImpact = function playCombatImpactSharp(event, playerIndex) {
    return this.playSharpCombatImpact(event, playerIndex);
  };

  prototype.playLocalCommandCue = function playLocalCommandCueSharp(kind = "action") {
    if (kind === "jump") return this.playImmediateAction("jump", {mode: this.listenerPoint?.mode});
    if (kind === "brake") return this.playImmediateAction("brake");
    return originalCommandCue.call(this, kind);
  };

  prototype.handleFreeEvent = function handleFreeEventSharp(event, playerIndex) {
    const now = this.ctx?.currentTime || 0;
    const localSource = event?.sourcePlayer === playerIndex;
    if (localSource && ["jump", "roof"].includes(event?.type) && now <= (this.localSharpJumpUntil || 0)) return;
    if (localSource && event?.type === "combat-swing" && now <= (this.localSharpAttackUntil || 0)) return;
    if (localSource && cargoEvents.has(event?.type) && now <= (this.localSharpCargoUntil || 0)) return;

    if (event?.targets?.includes(playerIndex) && event.type === "landing") {
      const spatial = this.eventPanAndGain(event, 82);
      const step = this.nextFootstep?.();
      if (step) this.playSharpBuffer(step, {pan: spatial.pan, gain: 0.38 * spatial.gain, rate: 0.86, highpass: 55, lowpass: 13_500, duration: 0.28});
      this.playSharpClick({pan: spatial.pan, frequency: 82, gain: 0.1 * Math.max(0.4, spatial.gain), duration: 0.06});
      return;
    }

    if (event?.targets?.includes(playerIndex) && event.type === "combat-swing") {
      const spatial = this.eventPanAndGain(event, 105);
      const name = event.heavy ? "swingHeavy" : "swingLight";
      this.playSharpBuffer(name, {pan: spatial.pan, gain: (event.heavy ? 0.42 : 0.3) * spatial.gain, rate: event.heavy ? 0.92 : 1.08, highpass: 280, lowpass: 16_000, duration: 0.34});
      return;
    }

    if (event?.targets?.includes(playerIndex) && cargoEvents.has(event.type)) {
      const spatial = this.eventPanAndGain(event, 90);
      if (this.buffers.has("repair")) this.playSharpBuffer("repair", {pan: spatial.pan, gain: 0.38 * spatial.gain, rate: event.type === "cargo-stowed" ? 0.98 : 1.16, highpass: 220, lowpass: 12_500, duration: 0.2});
      this.playSharpClick({pan: spatial.pan, frequency: 390, gain: 0.075 * Math.max(0.35, spatial.gain), duration: 0.04});
      return;
    }

    return originalHandleFreeEvent.call(this, event, playerIndex);
  };
}

installSharpFeedback();

function activeAudio() {
  return globalThis.__freeRoamSharpAudio || null;
}

function currentPlayerContext() {
  const api = globalThis.__freeRoam;
  const world = api?.getWorld?.();
  const playerIndex = api?.playerIndex?.() ?? 0;
  return {api, world, playerIndex, player: world?.players?.[playerIndex]};
}

function menusAreOpen(api, world, playerIndex) {
  return Boolean(
    api?.targeting?.()?.open
    || world?.freeActivities?.shopOpen?.[playerIndex]
    || world?.freeContracts?.boardOpen?.[playerIndex]
  );
}

function playAttackNow() {
  const audio = activeAudio();
  const {api, world, playerIndex, player} = currentPlayerContext();
  if (!audio || !world || menusAreOpen(api, world, playerIndex) || player?.combat?.alive === false || player?.combat?.knockedDown) return;
  audio.playImmediateAction("attack", {weapon: player?.combat?.equipped || "fists"});
}

function playCargoNow() {
  const audio = activeAudio();
  const {api, world, playerIndex} = currentPlayerContext();
  if (!audio || !world || menusAreOpen(api, world, playerIndex) || !likelyCargoAction(world, playerIndex)) return;
  audio.playImmediateAction("cargo");
}

if (typeof document !== "undefined") {
  document.addEventListener("keydown", event => {
    if (document.querySelector("#game")?.hidden || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
    if (event.code === "KeyX") playAttackNow();
    else if (event.code === "KeyF") playCargoNow();
  }, true);

  document.addEventListener("pointerdown", event => {
    const button = event.target?.closest?.("button");
    if (button?.id === "attackButton") playAttackNow();
    else if (button?.id === "actionButton") playCargoNow();
  }, true);

  document.addEventListener("click", event => {
    if (event.detail !== 0) return;
    const button = event.target?.closest?.("button");
    if (button?.id === "attackButton") playAttackNow();
    else if (button?.id === "actionButton") playCargoNow();
  }, true);
}
