from pathlib import Path

prediction = Path("public/src/free-roam-client-prediction.js")
prediction.write_text(r'''"use strict";

import {CONFIG} from "./game-core-v18.js?free=prediction";
import {WORLD} from "./free-roam-core-v6.js?v=44";
import {operationSteeringDelta} from "./free-roam-steering-model.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const rad = degrees => degrees * Math.PI / 180;

function blendAngle(authoritative, predicted, keep) {
  const difference = wrapDeg((Number(predicted) || 0) - (Number(authoritative) || 0));
  return wrapDeg((Number(authoritative) || 0) + difference * keep);
}

export function localPredictionLeadSeconds({networkRttMs, inputReceiptMs, controlLatencyMs} = {}) {
  const preferred = [networkRttMs, inputReceiptMs, controlLatencyMs]
    .map(Number)
    .find(value => Number.isFinite(value) && value > 0);
  if (!preferred) return 0;
  return clamp(preferred / 2_000, 0, 0.18);
}

export function reconcileLocalPrediction(previousWorld, nextWorld, playerIndex, options = {}) {
  const previousPlayer = previousWorld?.players?.[playerIndex];
  const nextPlayer = nextWorld?.players?.[playerIndex];
  if (!previousPlayer || !nextPlayer || previousPlayer.mode !== nextPlayer.mode) return nextWorld;

  if (nextPlayer.mode === "boat" && previousPlayer.activeBoat === nextPlayer.activeBoat) {
    const previousBoat = previousWorld.boats?.[previousPlayer.activeBoat];
    const nextBoat = nextWorld.boats?.[nextPlayer.activeBoat];
    if (!previousBoat || !nextBoat || nextBoat.sunk) return nextWorld;
    const error = Math.hypot(previousBoat.x - nextBoat.x, previousBoat.y - nextBoat.y);
    if (error > 10) return nextWorld;
    const keep = 0.72;
    nextBoat.x += (previousBoat.x - nextBoat.x) * keep;
    nextBoat.y += (previousBoat.y - nextBoat.y) * keep;
    nextBoat.heading = blendAngle(nextBoat.heading, previousBoat.heading, keep);
    nextBoat.speed += (previousBoat.speed - nextBoat.speed) * keep;
    nextBoat.throttle += (previousBoat.throttle - nextBoat.throttle) * keep;
    nextPlayer.x = nextBoat.x;
    nextPlayer.y = nextBoat.y;
    nextPlayer.heading = nextBoat.heading;
    return nextWorld;
  }

  if (["foot", "swim"].includes(nextPlayer.mode)) {
    const error = Math.hypot(previousPlayer.x - nextPlayer.x, previousPlayer.y - nextPlayer.y);
    // Person prediction has no full collision model. A large disagreement is a
    // real boundary, hit or mode correction and must win immediately.
    if (error > 3.5) return nextWorld;
    const input = options.input || {};
    const moving = Boolean(input.up || input.down || input.left || input.right);
    const latencyBlend = clamp(((Number(options.networkRttMs) || 0) - 40) / 240, 0, 1);
    const keep = moving ? 0.72 + latencyBlend * 0.14 : 0.56;
    nextPlayer.x += (previousPlayer.x - nextPlayer.x) * keep;
    nextPlayer.y += (previousPlayer.y - nextPlayer.y) * keep;
    nextPlayer.heading = blendAngle(nextPlayer.heading, previousPlayer.heading, keep);
  }
  return nextWorld;
}

function predictBoat(world, playerIndex, input, dt) {
  const player = world.players?.[playerIndex];
  const boat = player?.mode === "boat" ? world.boats?.[player.activeBoat] : null;
  if (!boat || boat.sunk || boat.driver !== playerIndex) return;
  const steer = Number(Boolean(input.right)) - Number(Boolean(input.left));
  const thrust = Number(Boolean(input.up)) - Number(Boolean(input.down));
  if (thrust) {
    boat.throttle += (thrust - (Number(boat.throttle) || 0)) * Math.min(1, dt * 4.5);
  } else {
    boat.throttle = 0;
  }
  if (boat.engineStalled || boat.emergencyActive) boat.throttle = 0;
  if (!thrust && !boat.engineStalled && !boat.emergencyActive) {
    boat.speed *= Math.exp(-0.028 * dt);
  } else {
    const targetSpeed = boat.throttle >= 0
      ? boat.throttle * CONFIG.maxSpeed
      : boat.throttle * Math.abs(CONFIG.reverseSpeed);
    boat.speed += clamp(targetSpeed - boat.speed, -CONFIG.acceleration * dt, CONFIG.acceleration * dt);
    boat.speed *= Math.max(0, 1 - CONFIG.drag * dt * (0.12 + Math.abs(boat.speed) / CONFIG.maxSpeed * 0.16));
  }
  if (steer) boat.heading = wrapDeg(boat.heading + operationSteeringDelta(boat.speed, steer, dt));
  boat.x = clamp(boat.x + Math.sin(rad(boat.heading)) * boat.speed * dt, WORLD.boatRadius, WORLD.width - WORLD.boatRadius);
  boat.y = clamp(boat.y - Math.cos(rad(boat.heading)) * boat.speed * dt, WORLD.shoreY + 4, WORLD.height - WORLD.boatRadius);
  player.x = boat.x;
  player.y = boat.y;
  player.heading = boat.heading;
}

function predictPerson(world, playerIndex, input, dt) {
  const player = world.players?.[playerIndex];
  if (!player || !["foot", "swim"].includes(player.mode) || player.combat?.knockedDown) return;
  let dx = Number(Boolean(input.right)) - Number(Boolean(input.left));
  let dy = Number(Boolean(input.down)) - Number(Boolean(input.up));
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return;
  dx /= length;
  dy /= length;
  const speed = player.mode === "swim" ? 6 : input.run ? 13.76 : 8;
  player.x = clamp(player.x + dx * speed * dt, 5, WORLD.width - 5);
  player.y = clamp(player.y + dy * speed * dt, 5, WORLD.height - 5);
  player.heading = Math.atan2(dx, -dy) * 180 / Math.PI;
}

export function predictLocalWorld(world, playerIndex, input, dt) {
  const safeDt = clamp(Number(dt) || 0, 0, 0.05);
  if (!world || safeDt <= 0) return world;
  predictBoat(world, playerIndex, input || {}, safeDt);
  predictPerson(world, playerIndex, input || {}, safeDt);
  return world;
}

export function predictLocalWorldAhead(world, playerIndex, input, seconds) {
  let remaining = clamp(Number(seconds) || 0, 0, 0.18);
  while (remaining > 0.0001) {
    const chunk = Math.min(0.05, remaining);
    predictLocalWorld(world, playerIndex, input, chunk);
    remaining -= chunk;
  }
  return world;
}
''', encoding="utf-8")

client = Path("public/src/free-roam-v4.js")
text = client.read_text(encoding="utf-8")
text = text.replace(
    'import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=43";\nimport {predictLocalWorld, reconcileLocalPrediction} from "./free-roam-client-prediction.js?v=41";',
    'import {FreeRoamAudio} from "./free-roam-audio-v5.js?v=44";\nimport {\n  localPredictionLeadSeconds,\n  predictLocalWorld,\n  predictLocalWorldAhead,\n  reconcileLocalPrediction,\n} from "./free-roam-client-prediction.js?v=42";',
)
old = '''      const renderWorld = typeof structuredClone === "function"
        ? structuredClone(authoritativeWorld)
        : JSON.parse(JSON.stringify(authoritativeWorld));
      world = reconcileLocalPrediction(previousWorld, renderWorld, playerIndex);'''
new = '''      const renderWorld = typeof structuredClone === "function"
        ? structuredClone(authoritativeWorld)
        : JSON.parse(JSON.stringify(authoritativeWorld));
      const predictionLead = localPredictionLeadSeconds({networkRttMs, inputReceiptMs, controlLatencyMs});
      predictLocalWorldAhead(renderWorld, playerIndex, localInput, predictionLead);
      world = reconcileLocalPrediction(previousWorld, renderWorld, playerIndex, {
        input: localInput,
        networkRttMs,
      });'''
if old not in text:
    raise SystemExit("authoritative reconciliation marker missing")
text = text.replace(old, new, 1)
old = '''    predictLocalWorld(world, playerIndex, localInput, dt);
    if (now - lastRenderAt >= 32) {'''
new = '''    predictLocalWorld(world, playerIndex, localInput, dt);
    audio.updateLocalFeedback?.(world, playerIndex, localInput);
    if (now - lastRenderAt >= 32) {'''
if old not in text:
    raise SystemExit("frame marker missing")
text = text.replace(old, new, 1)
old = '''  if (action === "open-targets") targetMenu.open();
  else if (action === "report") targetMenu.reportCurrent();
  else actionPulse("sonar");'''
new = '''  if (action === "open-targets") targetMenu.open();
  else if (action === "report") targetMenu.reportCurrent();
  else {
    audio.playLocalCommandCue?.("sonar");
    actionPulse("sonar");
  }'''
if old not in text:
    raise SystemExit("sonar marker missing")
text = text.replace(old, new, 1)
old = '''    } else if (!event.repeat && event.code === "Space") {
      event.preventDefault();
      actionPulse("jump");'''
new = '''    } else if (!event.repeat && event.code === "Space") {
      event.preventDefault();
      audio.playLocalCommandCue?.(world?.players?.[playerIndex]?.mode === "boat" ? "brake" : "jump");
      actionPulse("jump");'''
if old not in text:
    raise SystemExit("keyboard jump marker missing")
text = text.replace(old, new, 1)
old = '$("jumpButton").addEventListener("click", () => actionPulse("jump"));'
new = '''$("jumpButton").addEventListener("click", () => {
  audio.playLocalCommandCue?.(world?.players?.[playerIndex]?.mode === "boat" ? "brake" : "jump");
  actionPulse("jump");
});'''
if old not in text:
    raise SystemExit("jump button marker missing")
text = text.replace(old, new, 1)
client.write_text(text, encoding="utf-8")

audio = Path("public/src/free-roam-audio-v5.js")
text = audio.read_text(encoding="utf-8")
old = '''    this.cargoBeaconAt = new Map();
    this.merchantChimeAt = 0;
    this.contractBoardChimeAt = 0;'''
new = '''    this.cargoBeaconAt = new Map();
    this.merchantChimeAt = 0;
    this.contractBoardChimeAt = 0;
    this.localStepAt = 0;
    this.localStepMode = "";
    this.localStepX = null;
    this.localStepY = null;
    this.localMovementSuppressUntil = 0;
    this.localFireAt = 0;
    this.localFireBudget = 0;
    this.localFireSuppressUntil = 0;'''
if old not in text:
    raise SystemExit("audio constructor marker missing")
text = text.replace(old, new, 1)
old = '''  nextFootstep() {
    const names = ["stepV25_1", "stepV25_2", "stepV25_3", "stepV25_4"].filter(name => this.buffers.has(name));
    if (!names.length) return super.nextFootstep();
    const name = names[this.footstepIndex % names.length];
    this.footstepIndex += 1;
    return name;
  }
'''
new = old + r'''
  playLocalCommandCue(kind = "action") {
    if (!this.ctx) return false;
    const frequency = kind === "sonar" ? 610 : kind === "brake" ? 190 : 340;
    this.playSynthPip({frequency, gain: 0.035, duration: 0.045});
    return true;
  }

  updateLocalFeedback(world, playerIndex, input = {}) {
    if (!this.ctx) return;
    const player = world?.players?.[playerIndex];
    const combat = player?.combat;
    const now = this.ctx.currentTime;
    const movingInput = Boolean(input.up || input.down || input.left || input.right);
    const personMode = ["foot", "swim"].includes(player?.mode);
    const moved = this.localStepX == null || this.localStepY == null
      ? false
      : Math.hypot((Number(player?.x) || 0) - this.localStepX, (Number(player?.y) || 0) - this.localStepY) > 0.004;
    this.localStepX = Number(player?.x) || 0;
    this.localStepY = Number(player?.y) || 0;

    const movementActive = Boolean(
      personMode
      && movingInput
      && moved
      && combat?.alive !== false
      && !combat?.knockedDown
    );
    if (!movementActive) {
      this.localStepAt = 0;
      this.localStepMode = player?.mode || "";
    } else {
      const running = player.mode === "foot" && Boolean(input.run || player.running);
      const interval = player.mode === "swim" ? 0.58 : running ? 0.27 : 0.46;
      if (!this.localStepAt || this.localStepMode !== player.mode || now > this.localStepAt + interval * 1.6) {
        this.localStepAt = now;
        this.localStepMode = player.mode;
      }
      if (now + 0.008 >= this.localStepAt) {
        this.walkAlternation *= -1;
        const side = Number(Boolean(input.right)) - Number(Boolean(input.left));
        const pan = clamp(side * 0.56 + this.walkAlternation * (side ? 0.08 : 0.17), -0.88, 0.88);
        let played = false;
        if (player.mode === "swim") {
          const name = this.buffers.has("waterSide") ? "waterSide" : this.buffers.has("waterSoft") ? "waterSoft" : null;
          if (name) {
            this.play(name, {gain: 0.29, rate: 0.9 + Math.random() * 0.08, pan, lowpass: 6500});
            played = true;
          }
        } else {
          const name = this.nextFootstep();
          if (name) {
            this.play(name, {gain: running ? 0.29 : 0.22, rate: running ? 1.15 : 0.98, pan});
            played = true;
          }
        }
        if (played) this.localMovementSuppressUntil = now + 1.25;
        this.localStepAt = now + interval;
      }
    }

    const automaticAmmo = Math.max(0, Math.floor(Number(combat?.ammo) || 0));
    const localAutomatic = Boolean(
      input.attack
      && combat?.alive !== false
      && !combat?.knockedDown
      && combat?.equipped === "automatic"
      && combat?.weapons?.automatic
      && automaticAmmo > 0
    );
    if (!localAutomatic) {
      this.localFireAt = 0;
      this.localFireBudget = 0;
      return;
    }
    if (!this.localFireAt) {
      this.localFireAt = now;
      this.localFireBudget = automaticAmmo;
    } else {
      this.localFireBudget = Math.min(this.localFireBudget, automaticAmmo);
    }
    const interval = Math.max(0.08, Number(COMBAT_TUNING.automaticShotInterval) || 0.12);
    if (now > this.localFireAt + interval * 1.8) this.localFireAt = now;
    if (now + 0.006 < this.localFireAt || this.localFireBudget <= 0 || !this.buffers.has("automaticShot")) return;
    this.play("automaticShot", {
      pan: 0,
      gain: COMBAT_TUNING.automaticShotGain,
      rate: 0.98 + Math.random() * 0.04,
      lowpass: 12000,
    });
    this.localFireBudget -= 1;
    this.localFireSuppressUntil = now + 2;
    this.localFireAt = now + interval;
  }
'''
if old not in text:
    raise SystemExit("nextFootstep marker missing")
text = text.replace(old, new, 1)
old = '''  handleFreeEvent(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    const spatial = this.eventPanAndGain(event, 145);'''
new = '''  handleFreeEvent(event, playerIndex) {
    if (!event?.targets?.includes(playerIndex)) return;
    const localNow = this.ctx?.currentTime || 0;
    if (
      event.sourcePlayer === playerIndex
      && ["footstep", "swim-step"].includes(event.type)
      && localNow <= this.localMovementSuppressUntil
    ) return;
    if (
      event.type === "gun-shot"
      && event.sourcePlayer === playerIndex
      && event.weapon !== "pistol"
      && localNow <= this.localFireSuppressUntil
    ) return;
    const spatial = this.eventPanAndGain(event, 145);'''
if old not in text:
    raise SystemExit("audio event marker missing")
text = text.replace(old, new, 1)
audio.write_text(text, encoding="utf-8")

pistol = Path("public/src/free-roam-pistol-audio.js")
text = pistol.read_text(encoding="utf-8").replace('free-roam-audio-v5.js?v=43', 'free-roam-audio-v5.js?v=44')
pistol.write_text(text, encoding="utf-8")

html = Path("public/free-roam.html")
text = html.read_text(encoding="utf-8")
text = text.replace('src/free-roam-v4.js?v=52', 'src/free-roam-v4.js?v=53')
text = text.replace('src/free-roam-pistol-audio.js?v=3', 'src/free-roam-pistol-audio.js?v=4')
html.write_text(text, encoding="utf-8")

Path("tests/free-roam-client-prediction-latency.test.mjs").write_text(r'''import test from "node:test";
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
''', encoding="utf-8")
