"use strict";

import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=45";
import {relativeMovementPan} from "./free-roam-audio-v3.js?v=38";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const distance = (a, b) => Math.hypot(
  (Number(a?.x) || 0) - (Number(b?.x) || 0),
  (Number(a?.y) || 0) - (Number(b?.y) || 0),
);
const BULLET_AUDIO_RANGE = 96;
const MAX_BULLET_AUDIO_VOICES = 8;

function listenerPoint(world, playerIndex, fallback) {
  const player = world?.players?.[playerIndex];
  if (!player) return fallback || null;
  if (["boat", "roof"].includes(player.mode)) {
    return (world.boats || []).find(boat => String(boat?.id) === String(player.activeBoat))
      || world.boats?.[player.activeBoat]
      || player;
  }
  return player;
}

function voiceMap(audio) {
  audio.eliteBulletVoices ||= new Map();
  return audio.eliteBulletVoices;
}

function stopBulletVoice(audio, projectileId, fade = 0.035) {
  const voices = voiceMap(audio);
  const voice = voices.get(String(projectileId));
  if (!voice) return;
  voices.delete(String(projectileId));
  if (!audio.ctx) {
    try { voice.source.stop(); } catch (_) {}
    return;
  }
  const now = audio.ctx.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setTargetAtTime(0, now, Math.max(0.008, fade));
  try { voice.source.stop(now + Math.max(0.06, fade * 4)); } catch (_) {}
}

function stopAllBulletVoices(audio) {
  for (const projectileId of [...voiceMap(audio).keys()]) stopBulletVoice(audio, projectileId, 0.018);
}

function createBulletVoice(audio, projectile) {
  if (!audio.ctx || !audio.master) return null;
  const source = audio.ctx.createOscillator();
  const filter = audio.ctx.createBiquadFilter();
  const panner = audio.ctx.createStereoPanner();
  const gain = audio.ctx.createGain();
  source.type = "sawtooth";
  source.frequency.value = 1200;
  filter.type = "bandpass";
  filter.frequency.value = 1800;
  filter.Q.value = 0.75;
  gain.gain.value = 0;
  source.connect(filter).connect(panner).connect(gain).connect(audio.master);
  source.start();
  const voice = {source, filter, panner, gain};
  voiceMap(audio).set(String(projectile.id), voice);
  return voice;
}

function updateBulletVoices(audio, world, playerIndex) {
  const listener = listenerPoint(world, playerIndex, audio.listenerPoint);
  const boss = world?.freeEliteBoatBoss;
  if (!audio.ctx || !audio.master || !listener || !boss?.active) {
    stopAllBulletVoices(audio);
    return;
  }

  const audible = (boss.projectiles || [])
    .filter(projectile => projectile && Number(projectile.energy) > 0.01)
    .map(projectile => ({projectile, metres: distance(listener, projectile)}))
    .filter(item => item.metres <= BULLET_AUDIO_RANGE)
    .sort((left, right) => left.metres - right.metres)
    .slice(0, MAX_BULLET_AUDIO_VOICES);
  const activeIds = new Set(audible.map(item => String(item.projectile.id)));
  const now = audio.ctx.currentTime;

  for (const {projectile, metres} of audible) {
    const id = String(projectile.id);
    const voice = voiceMap(audio).get(id) || createBulletVoice(audio, projectile);
    if (!voice) continue;
    const dx = (Number(listener.x) || 0) - (Number(projectile.x) || 0);
    const dy = (Number(listener.y) || 0) - (Number(projectile.y) || 0);
    const length = Math.max(0.001, Math.hypot(dx, dy));
    const vx = Number(projectile.vx) || 0;
    const vy = Number(projectile.vy) || 0;
    const speed = Math.max(0, Number(projectile.speed) || Math.hypot(vx, vy));
    const radialVelocity = (vx * dx + vy * dy) / length;
    const proximity = clamp(1 - metres / BULLET_AUDIO_RANGE, 0, 1);
    const energy = clamp(projectile.energy, 0, 1);
    const frequency = clamp(760 + speed * 8.5 + proximity * 900 + radialVelocity * 3.2, 520, 4200);
    const filterFrequency = clamp(frequency * 1.25 + proximity * 700, 800, 6200);
    const gain = clamp(Math.pow(proximity, 1.7) * (0.008 + energy * 0.026), 0, 0.034);
    voice.source.frequency.setTargetAtTime(frequency, now, 0.025);
    voice.filter.frequency.setTargetAtTime(filterFrequency, now, 0.035);
    voice.panner.pan.setTargetAtTime(relativeMovementPan(listener, projectile), now, 0.025);
    voice.gain.gain.setTargetAtTime(gain, now, 0.035);
  }

  for (const projectileId of [...voiceMap(audio).keys()]) {
    if (!activeIds.has(projectileId)) stopBulletVoice(audio, projectileId);
  }
}

if (!FreeRoamAudio.prototype.__eliteBoatAudioV13) {
  const inheritedHandleFreeEvent = FreeRoamAudio.prototype.handleFreeEvent;
  const inheritedUpdateMarauderEngine = FreeRoamAudio.prototype.updateMarauderEngine;
  const inheritedUpdateWorld = FreeRoamAudio.prototype.updateWorld;
  const inheritedStopAll = FreeRoamAudio.prototype.stopAll;

  Object.defineProperty(FreeRoamAudio.prototype, "__eliteBoatAudioV13", {value: true});

  FreeRoamAudio.prototype.updateMarauderEngine = function updateEliteBoatEngine(world) {
    inheritedUpdateMarauderEngine.call(this, world);
    const elite = world?.freeEliteBoatBoss?.boat;
    if (!this.ctx || !this.marauderEngine || !this.listenerPoint || !elite?.active || elite.destroyed) return;
    if (String(this.marauderEngine.trackedId || "") !== String(elite.id || "")) return;
    const metres = distance(this.listenerPoint, elite);
    if (metres > 190) return;

    const engine = elite.engineAudio || {};
    const rpm = clamp(engine.rpm ?? Math.abs(Number(elite.speed) || 0) / Math.max(1, Number(elite.maxSpeed) || 23), 0, 1);
    const load = clamp(engine.load, 0, 1);
    const damage = clamp(engine.damage, 0, 1);
    const turnLoad = clamp(engine.turnLoad, 0, 1);
    const proximity = clamp(1 - metres / 190, 0, 1);
    const now = this.ctx.currentTime;

    let rate = 0.62 + rpm * 0.34;
    if (engine.state === "full-power") rate += 0.06;
    if (engine.state === "decelerating") rate -= 0.05;
    if (engine.state === "hard-turn") rate += 0.025 * turnLoad;
    if (engine.state === "damaged") rate -= 0.08 + damage * 0.07;
    this.marauderEngine.source.playbackRate.setTargetAtTime(clamp(rate, 0.48, 1.08), now, 0.13);

    const filter = 330 + proximity * 2450 + load * 520 - damage * 620;
    this.marauderEngine.filter.frequency.setTargetAtTime(clamp(filter, 260, 3900), now, 0.16);
    const gain = 0.012 + proximity * (0.13 + load * 0.055) + turnLoad * 0.018;
    this.marauderEngine.gain.gain.setTargetAtTime(clamp(gain, 0, 0.23), now, 0.16);
  };

  FreeRoamAudio.prototype.updateWorld = function updateEliteBoatWorldAudio(world, playerIndex) {
    inheritedUpdateWorld.call(this, world, playerIndex);
    updateBulletVoices(this, world, playerIndex);
  };

  FreeRoamAudio.prototype.stopAll = function stopEliteBoatAudio() {
    stopAllBulletVoices(this);
    return inheritedStopAll.call(this);
  };

  FreeRoamAudio.prototype.handleFreeEvent = function handleEliteBoatAudio(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    if (event.type === "elite-bullet-ended" && event.projectileId) stopBulletVoice(this, event.projectileId, 0.012);
    const spatial = this.eventPanAndGain(event, 240);

    switch (event.type) {
      case "elite-bomb-bay-opening":
        this.playSynthPip({pan: spatial.pan, frequency: 82, gain: 0.13 * spatial.gain, duration: 0.18});
        this.playSynthPip({pan: spatial.pan, frequency: 112, gain: 0.15 * spatial.gain, duration: 0.16, delay: 0.16});
        this.playSynthPip({pan: spatial.pan, frequency: 148, gain: 0.17 * spatial.gain, duration: 0.14, delay: 0.32});
        return;
      case "elite-bomb-bay-closing":
        this.playSynthPip({pan: spatial.pan, frequency: 145, gain: 0.14 * spatial.gain, duration: 0.14});
        this.playSynthPip({pan: spatial.pan, frequency: 104, gain: 0.15 * spatial.gain, duration: 0.17, delay: 0.14});
        this.playSynthPip({pan: spatial.pan, frequency: 76, gain: 0.16 * spatial.gain, duration: 0.19, delay: 0.29});
        return;
      case "elite-bomb-bay-closed":
        this.playSynthPip({pan: spatial.pan, frequency: 64, gain: 0.19 * spatial.gain, duration: 0.09});
        this.playSynthPip({pan: spatial.pan, frequency: 48, gain: 0.13 * spatial.gain, duration: 0.12, delay: 0.07});
        return;
      case "elite-bomb-bay-armoured-hit":
        this.playSynthPip({pan: spatial.pan, frequency: 110, gain: 0.16 * spatial.gain, duration: 0.08});
        this.playSynthPip({pan: spatial.pan, frequency: 70, gain: 0.12 * spatial.gain, duration: 0.12, delay: 0.05});
        return;
      case "elite-bomb-bay-hit":
        this.play("gunHit", {pan: spatial.pan, gain: 0.82 * spatial.gain, rate: 0.86, lowpass: 6200});
        return;
      case "elite-bomb-bay-destroyed":
        this.playSynthPip({pan: spatial.pan, frequency: 410, gain: 0.2 * spatial.gain, duration: 0.08});
        this.playSynthPip({pan: spatial.pan, frequency: 92, gain: 0.23 * spatial.gain, duration: 0.34, delay: 0.09});
        return;
      case "elite-bomb-bay-internal-detonation":
        this.playSynthPip({pan: spatial.pan, frequency: 62, gain: 0.28 * spatial.gain, duration: 0.48});
        this.playSynthPip({pan: spatial.pan, frequency: 38, gain: 0.24 * spatial.gain, duration: 0.58, delay: 0.08});
        return;
      case "elite-bullet-flyby":
        this.playSynthPip({pan: spatial.pan, frequency: 1850, gain: 0.065 * spatial.gain, duration: 0.035});
        return;
      case "elite-bullet-ended":
        if (["terrain-impact", "boundary-impact"].includes(event.reason)) {
this.play("gunHit", {pan: spatial.pan, gain: 0.35 * spatial.gain, rate: 1.18, lowpass: 5200});
        }
        return;
      case "elite-boat-boundary-impact":
        this.playSynthPip({pan: spatial.pan, frequency: 58, gain: 0.25 * spatial.gain, duration: 0.3});
        this.playSynthPip({pan: spatial.pan, frequency: 92, gain: 0.16 * spatial.gain, duration: 0.16, delay: 0.04});
        return;
      case "elite-ram-impact":
        this.playSynthPip({pan: spatial.pan, frequency: 48, gain: 0.3 * spatial.gain, duration: 0.38});
        this.playSynthPip({pan: spatial.pan, frequency: 76, gain: 0.2 * spatial.gain, duration: 0.24, delay: 0.04});
        return;
      default:
        return inheritedHandleFreeEvent.call(this, event, playerIndex);
    }
  };
}
