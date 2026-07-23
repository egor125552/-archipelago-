"use strict";

import {FreeRoamAudio as BaseFreeRoamAudio, spatialGainForDistance} from "./free-roam-audio-v4.js?v=38";
import {relativeMovementPan} from "./free-roam-audio-v3.js?v=38";
import {injuryLowpassFrequency} from "./free-roam-combat-recovery.js?v=32";
import {COMBAT_TUNING} from "./free-roam-combat-tuning.js?v=32";
import {MERCHANT, MERCHANT_AUDIO_RANGE} from "./free-roam-shop.js?v=1";

const ROOT = "/assets/audio/free-roam-v25/";
const COMBAT_SOUNDS = Object.freeze({
  heartbeatFast: ROOT + "heartbeat-fast.mp3",
  deathFull: ROOT + "death-full.mp3",
  swingLight: ROOT + "swing-light.mp3",
  swingHeavy: ROOT + "swing-heavy.mp3",
  punch1: ROOT + "punch-1.mp3",
  punch2: ROOT + "punch-2.mp3",
  punch3: ROOT + "punch-3.mp3",
  punchHeavy: ROOT + "punch-heavy.mp3",
  punchBodySet: ROOT + "punch-body-set.mp3",
  hitPlayer: ROOT + "hit-player.mp3",
  knifeDraw: ROOT + "knife-draw.mp3",
  knife1: ROOT + "knife-1.mp3",
  knife2: ROOT + "knife-2.mp3",
  knife3: ROOT + "knife-3.mp3",
  automaticShot: ROOT + "automatic-shot.mp3",
  gunHit: ROOT + "gun-hit.mp3",
  stepV25_1: ROOT + "step-1.mp3",
  stepV25_2: ROOT + "step-2.mp3",
  stepV25_3: ROOT + "step-3.mp3",
  stepV25_4: ROOT + "step-4.mp3",
  lakeWaterV25: ROOT + "lake-water.mp3",
  swimImpactV25: ROOT + "swim-impact.mp3",
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
const SONAR_AUDIBLE_RANGE = 560;

export class FreeRoamAudio extends BaseFreeRoamAudio {
  constructor() {
    super();
    this.combatPreloadPromise = null;
    this.injuryDry = null;
    this.injuryWet = null;
    this.injuryReverb = null;
    this.injuryFilter = null;
    this.injuryMix = 0;
    this.combatSoundIndex = 0;
    this.deathSource = null;
    this.marauderEngine = null;
    this.cargoBeaconAt = new Map();
    this.merchantChimeAt = 0;
  }

  async init() {
    await super.init();
    if (this.combatPreloadPromise) await this.combatPreloadPromise;
    this.setupInjuryReverb();
  }

  async preload() {
    const inherited = super.preload();
    if (!this.ctx) return inherited;
    this.combatPreloadPromise = Promise.allSettled(Object.entries(COMBAT_SOUNDS).map(async ([name, url]) => {
      const response = await fetch(url, {cache: "force-cache"});
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      this.buffers.set(name, await this.ctx.decodeAudioData(await response.arrayBuffer()));
    }));
    await Promise.allSettled([inherited, this.combatPreloadPromise]);
    if (this.buffers.has("lakeWaterV25")) this.buffers.set("riverIdle", this.buffers.get("lakeWaterV25"));
    if (this.buffers.has("swimImpactV25")) {
      this.buffers.set("waterSide", this.buffers.get("swimImpactV25"));
      this.buffers.set("waterSoft", this.buffers.get("swimImpactV25"));
    }
  }

  setupInjuryReverb() {
    if (!this.ctx || !this.master || !this.compressor || this.injuryReverb) return;
    this.injuryDry = this.ctx.createGain();
    this.injuryWet = this.ctx.createGain();
    this.injuryReverb = this.ctx.createConvolver();
    this.injuryFilter = this.ctx.createBiquadFilter();
    this.injuryFilter.type = "lowpass";
    this.injuryFilter.frequency.value = injuryLowpassFrequency(0);
    this.injuryFilter.Q.value = 0.7;
    this.injuryDry.gain.value = 1;
    this.injuryWet.gain.value = 0;

    const length = Math.floor(this.ctx.sampleRate * 1.65);
    const impulse = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < length; index += 1) {
        const fade = Math.pow(1 - index / length, 2.5);
        data[index] = (Math.random() * 2 - 1) * fade;
      }
    }
    this.injuryReverb.buffer = impulse;
    try { this.master.disconnect(); } catch (_) {}
    this.master.connect(this.injuryFilter);
    this.injuryFilter.connect(this.injuryDry).connect(this.compressor);
    this.injuryFilter.connect(this.injuryWet).connect(this.injuryReverb).connect(this.compressor);
  }

  smoothInjuryMix(nextMix) {
    const mix = clamp(Number(nextMix) || 0, 0, 1);
    this.injuryMix = mix;
    if (!this.ctx || !this.injuryDry || !this.injuryWet) return;
    const now = this.ctx.currentTime;
    this.injuryFilter?.frequency.setTargetAtTime(injuryLowpassFrequency(this.injuryMix), now, 0.36);
    this.injuryDry.gain.setTargetAtTime(1 - this.injuryMix * 0.16, now, 0.28);
    this.injuryWet.gain.setTargetAtTime(this.injuryMix * 0.5, now, 0.34);
    if (this.injuryMix > 0.015 && this.buffers.has("heartbeatFast")) {
      this.ensureLoop("heartbeatFast", {
        gain: 0.015 + this.injuryMix * 0.34,
        rate: 0.86 + this.injuryMix * 0.18,
        lowpass: 3000 + this.injuryMix * 3600,
      });
    } else {
      this.stopLoop("heartbeatFast");
    }
  }

  nextFootstep() {
    const names = ["stepV25_1", "stepV25_2", "stepV25_3", "stepV25_4"].filter(name => this.buffers.has(name));
    if (!names.length) return super.nextFootstep();
    const name = names[this.footstepIndex % names.length];
    this.footstepIndex += 1;
    return name;
  }

  nextSound(prefix, count) {
    const start = this.combatSoundIndex++;
    for (let offset = 0; offset < count; offset += 1) {
      const name = `${prefix}${(start + offset) % count + 1}`;
      if (this.buffers.has(name)) return name;
    }
    return null;
  }

  eventPanAndGain(event, maximum = 110) {
    if (!this.listenerPoint) return {pan: Number(event?.pan) || 0, gain: 1};
    const metres = distance(this.listenerPoint, event);
    return {
      pan: relativeMovementPan(this.listenerPoint, event),
      gain: spatialGainForDistance(metres, maximum),
    };
  }

  updateCargoBeacons(world, playerIndex) {
    if (!this.ctx || !this.listenerPoint) return;
    const scenario = world?.freeScenario;
    const target = scenario?.targets?.[playerIndex];
    if (!target || (Number(scenario?.beaconUntil?.[playerIndex]) || 0) <= (Number(world?.time) || 0)) return;
    const now = this.ctx.currentTime;
    const metres = distance(this.listenerPoint, target);
    if (metres > SONAR_AUDIBLE_RANGE) return;
    const previous = this.cargoBeaconAt.get(target.id) || 0;
    const interval = clamp(0.16 + metres / 42, 0.16, 2.7);
    if (now < previous) return;
    this.cargoBeaconAt.set(target.id, now + interval);
    const pan = relativeMovementPan(this.listenerPoint, target);
    const proximity = clamp(1 - metres / SONAR_AUDIBLE_RANGE, 0, 1);
    const frequency = target.kind === "pursuer" ? 330 : target.kind === "automatic" ? 880 : target.kind === "merchant" ? 520 : 620;
    this.playSynthPip({pan, frequency, gain: 0.035 + proximity * 0.09, duration: 0.11});
  }

  updateMerchantAmbient(world, playerIndex) {
    if (!this.ctx || !this.listenerPoint) return;
    const player = world?.players?.[playerIndex];
    if (!player?.combat?.alive) return;
    const metres = distance(this.listenerPoint, MERCHANT);
    if (metres > MERCHANT_AUDIO_RANGE) return;
    const now = this.ctx.currentTime;
    if (now < this.merchantChimeAt) return;
    this.merchantChimeAt = now + 2.6;
    const pan = relativeMovementPan(this.listenerPoint, MERCHANT);
    const proximity = clamp(1 - metres / MERCHANT_AUDIO_RANGE, 0, 1);
    this.playSynthPip({pan, frequency: 440, gain: 0.025 + proximity * 0.07, duration: 0.08});
    this.playSynthPip({pan, frequency: 660, gain: 0.018 + proximity * 0.045, duration: 0.05});
  }

  startMarauderEngine() {
    if (this.marauderEngine || !this.ctx || !this.master || !this.buffers.has("motorboatReal")) return;
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();
    const gain = this.ctx.createGain();
    source.buffer = this.buffers.get("motorboatReal");
    source.loop = true;
    filter.type = "lowpass";
    filter.frequency.value = 900;
    gain.gain.value = 0;
    source.connect(filter).connect(panner).connect(gain).connect(this.master);
    source.start();
    this.marauderEngine = {source, filter, panner, gain};
  }

  updateMarauderEngine(world) {
    const targetId = world?.freeScenario?.targets?.[this.localPlayerIndex]?.id;
    const primary = world?.freeActivities?.marauder;
    const selectedEscort = world?.freePursuerSquad?.escorts?.find(escort => (
      escort.id === targetId && escort.active && !escort.destroyed
    ));
    const marauder = selectedEscort || primary;
    if (!this.ctx || !this.listenerPoint || !marauder?.active || marauder.destroyed) {
      if (this.ctx && this.marauderEngine) this.marauderEngine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.18);
      return;
    }
    const metres = distance(this.listenerPoint, marauder);
    if (metres > 190) {
      if (this.marauderEngine) this.marauderEngine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.18);
      return;
    }
    this.startMarauderEngine();
    if (!this.marauderEngine) return;
    const proximity = clamp(1 - metres / 190, 0, 1);
    const speed = clamp(Math.abs(marauder.speed) / 16, 0, 1);
    const pan = relativeMovementPan(this.listenerPoint, marauder);
    const now = this.ctx.currentTime;
    this.marauderEngine.source.playbackRate.setTargetAtTime(0.74 + speed * 0.24, now, 0.15);
    this.marauderEngine.filter.frequency.setTargetAtTime(650 + proximity * 2900, now, 0.18);
    this.marauderEngine.panner.pan.setTargetAtTime(pan, now, 0.12);
    this.marauderEngine.gain.gain.setTargetAtTime(0.012 + proximity * 0.16, now, 0.18);
  }

  updateWorld(world, playerIndex) {
    super.updateWorld(world, playerIndex);
    const combat = world?.players?.[playerIndex]?.combat;
    this.smoothInjuryMix(combat?.alive === false ? 1 : combat?.injuryMix || 0);
    this.updateCargoBeacons(world, playerIndex);
    this.updateMerchantAmbient(world, playerIndex);
    this.updateMarauderEngine(world);
  }

  playCombatImpact(event, playerIndex) {
    const spatial = event.weapon === "automatic"
      ? this.eventPanAndGain(event, COMBAT_TUNING.automaticImpactRange)
      : this.eventPanAndGain(event, 105);
    const localTarget = event.targetPlayer === playerIndex;
    const gain = (localTarget ? 0.68 : 0.44) * spatial.gain;
    if (event.weapon === "knife") {
      const name = this.nextSound("knife", 3);
      if (name) this.play(name, {pan: spatial.pan, gain, rate: event.heavy ? 0.9 : 1.02, lowpass: 9000});
    } else if (event.weapon === "automatic") {
      const impactGain = (localTarget ? 0.92 : 0.68)
        * spatial.gain
        * COMBAT_TUNING.automaticImpactGain;
      this.play("gunHit", {pan: spatial.pan, gain: impactGain, lowpass: 10500});
    } else {
      const name = event.heavy ? "punchHeavy" : this.nextSound("punch", 3);
      if (name) this.play(name, {pan: spatial.pan, gain, rate: event.heavy ? 0.92 : 0.98 + Math.random() * 0.08, lowpass: 7600});
    }
    if (localTarget) {
      this.play("hitPlayer", {
        gain: event.weapon === "automatic" ? 0.44 : 0.28,
        pan: 0,
        lowpass: event.weapon === "automatic" ? 7600 : 5200,
      });
    }
  }

  handleFreeEvent(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    const spatial = this.eventPanAndGain(event, 145);
    switch (event.type) {
      case "combat-swing":
        this.play(event.heavy ? "swingHeavy" : "swingLight", {
          pan: spatial.pan,
          gain: (event.heavy ? 0.34 : 0.22) * spatial.gain,
          rate: event.heavy ? 0.9 : 1,
        });
        return;
      case "combat-hit":
      case "combat-heavy-hit":
      case "gun-hit":
        this.playCombatImpact(event, playerIndex);
        return;
      case "weapon-switch":
        if (event.weapon === "knife") this.play("knifeDraw", {gain: 0.5});
        else this.playSynthPip({frequency: event.weapon === "automatic" ? 760 : 420, gain: 0.08, duration: 0.08});
        return;
      case "gun-shot": {
        const shotSpatial = this.eventPanAndGain(event, COMBAT_TUNING.automaticAudibleRange);
        this.play("automaticShot", {
          pan: shotSpatial.pan,
          gain: COMBAT_TUNING.automaticShotGain * shotSpatial.gain,
          rate: 0.98 + Math.random() * 0.04,
          lowpass: 12000,
        });
        return;
      }
      case "pursuer-aim": {
        const aimSpatial = this.eventPanAndGain(event, 520);
        const warningGain = 0.085 + aimSpatial.gain * 0.075;
        this.playSynthPip({pan: aimSpatial.pan, frequency: 260, gain: warningGain, duration: 0.08});
        this.playSynthPip({pan: aimSpatial.pan, frequency: 340, gain: warningGain * 1.08, duration: 0.1, delay: 0.14});
        return;
      }
      case "pursuer-target-lock":
        this.playSynthPip({pan: spatial.pan, frequency: 210, gain: 0.12, duration: 0.13});
        this.playSynthPip({pan: spatial.pan, frequency: 210, gain: 0.12, duration: 0.13, delay: 0.2});
        this.playSynthPip({pan: spatial.pan, frequency: 160, gain: 0.14, duration: 0.2, delay: 0.4});
        return;
      case "enemy-gun-shot": {
        const shotSpatial = this.eventPanAndGain(event, 780);
        this.play("automaticShot", {
          pan: shotSpatial.pan,
          gain: 0.72 * shotSpatial.gain,
          rate: 0.94,
          lowpass: 11500,
        });
        return;
      }
      case "enemy-bullet-near":
        this.play("swingLight", {
          pan: spatial.pan,
          gain: 0.42 * spatial.gain,
          rate: 1.28,
          lowpass: 9800,
        });
        return;
      case "enemy-bullet-boat-hit":
        this.play("gunHit", {pan: spatial.pan, gain: 0.9 * spatial.gain, lowpass: 9800});
        if (this.buffers.has("hullCreak")) {
          this.play("hullCreak", {pan: spatial.pan, gain: 0.24 * spatial.gain, rate: 0.82, lowpass: 4200});
        }
        return;
      case "escort-contact":
        this.handle([{
          type: "collision",
          severity: 0.82,
          impactSpeed: 5.5,
          hardImpact: false,
          damage: 0,
          pan: spatial.pan,
        }]);
        return;
      case "pursuer-hit":
      case "gunner-hit":
        if (event.weapon === "ram") {
          this.handle([{
            type: "collision",
            severity: 1.12,
            impactSpeed: 8.5,
            hardImpact: true,
            damage: event.damage || 9,
            pan: spatial.pan,
          }]);
          return;
        }
        this.play("gunHit", {
          pan: spatial.pan,
          gain: 0.72 * spatial.gain,
          lowpass: 8400,
        });
        return;
      case "pursuer-gunner-landed":
        this.playSynthPip({pan: spatial.pan, frequency: 310, gain: 0.13, duration: 0.12});
        this.playSynthPip({pan: spatial.pan, frequency: 190, gain: 0.15, duration: 0.22, delay: 0.16});
        return;
      case "gunner-destroyed":
        this.playSynthPip({pan: spatial.pan, frequency: 340, gain: 0.13, duration: 0.1});
        this.playSynthPip({pan: spatial.pan, frequency: 150, gain: 0.15, duration: 0.24, delay: 0.12});
        return;
      case "pursuer-ram":
        this.handle([{type: "collision", severity: 1.7, impactSpeed: event.strength || 8, hardImpact: true, damage: event.damage || 8, pan: spatial.pan}]);
        return;
      case "scenario-sonar":
        this.playSynthPip({pan: spatial.pan, frequency: 760, gain: 0.13, duration: 0.12});
        return;
      case "scenario-arrival":
        this.playSynthPip({pan: spatial.pan, frequency: 920, gain: 0.16, duration: 0.1});
        this.playSynthPip({pan: spatial.pan, frequency: 1120, gain: 0.18, duration: 0.13, delay: 0.16});
        if (event.targetId) this.cargoBeaconAt.set(event.targetId, (this.ctx?.currentTime || 0) + 0.8);
        return;
      case "pursuer-warning":
        this.playSynthPip({frequency: 270, gain: 0.11, duration: 0.18});
        return;
      case "pursuer-arrival":
        this.playSynthPip({pan: spatial.pan, frequency: 190, gain: 0.16, duration: 0.28});
        return;
      case "pursuer-destroyed":
        this.playSynthPip({pan: spatial.pan, frequency: 420, gain: 0.14, duration: 0.1});
        this.playSynthPip({pan: spatial.pan, frequency: 180, gain: 0.16, duration: 0.24, delay: 0.12});
        return;
      case "player-knockdown":
        if (this.buffers.has("punchBodySet")) {
          this.playExcerpt("punchBodySet", {offset: 0.2, duration: 0.82, pan: spatial.pan, gain: 0.34 * spatial.gain, lowpass: 6500});
        }
        return;
      case "player-death":
        if (event.targetPlayer === playerIndex) {
          try { this.deathSource?.stop(); } catch (_) {}
          this.deathSource = this.play("deathFull", {gain: 0.72, lowpass: 10000});
        }
        return;
      case "player-defeated":
        this.playSynthPip({frequency: 360, gain: 0.12, duration: 0.1});
        this.playSynthPip({frequency: 180, gain: 0.14, duration: 0.22, delay: 0.12});
        return;
      case "player-respawn":
        if (event.sourcePlayer === playerIndex) {
          try { this.deathSource?.stop(); } catch (_) {}
          this.deathSource = null;
          this.smoothInjuryMix(0);
          this.playSynthPip({frequency: 580, gain: 0.08, duration: 0.1});
          this.playSynthPip({frequency: 780, gain: 0.08, duration: 0.12, delay: 0.14});
        }
        return;
      case "cargo-pickup":
      case "cargo-stowed":
      case "cargo-transfer":
        this.play("repair", {pan: spatial.pan, gain: 0.25 * spatial.gain, rate: event.type === "cargo-stowed" ? 0.86 : 1.08, lowpass: 5200});
        return;
      case "cargo-stolen":
        this.play("repair", {pan: spatial.pan, gain: 0.31 * spatial.gain, rate: 0.72, lowpass: 3800});
        this.playSynthPip({pan: spatial.pan, frequency: 210, gain: 0.1, duration: 0.16, delay: 0.08});
        return;
      case "cargo-delivered":
        this.playSynthPip({frequency: 680, gain: 0.08, duration: 0.08});
        this.playSynthPip({frequency: 920, gain: 0.085, duration: 0.1, delay: 0.13});
        this.playSynthPip({frequency: 1180, gain: 0.08, duration: 0.11, delay: 0.27});
        return;
      case "marauder-steal":
        this.playSynthPip({pan: spatial.pan, frequency: 230, gain: 0.12, duration: 0.16});
        this.playSynthPip({pan: spatial.pan, frequency: 170, gain: 0.12, duration: 0.2, delay: 0.2});
        return;
      default:
        super.handleFreeEvent(event, playerIndex);
    }
  }

  stopAll() {
    try { this.deathSource?.stop(); } catch (_) {}
    this.deathSource = null;
    if (this.marauderEngine) {
      try { this.marauderEngine.source.stop(); } catch (_) {}
      this.marauderEngine = null;
    }
    this.stopLoop("heartbeatFast");
    super.stopAll();
  }
}
