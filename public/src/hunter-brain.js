"use strict";

import {HUNTER_BRAIN_WEIGHTS} from "./hunter-brain-weights.js?v=25.0";

export const HUNTER_FEATURE_COUNT = 18;
export const HUNTER_HIDDEN_ONE = 12;
export const HUNTER_HIDDEN_TWO = 8;
export const HUNTER_TACTICS = Object.freeze([
  "pressure",
  "intercept",
  "flank-left",
  "flank-right",
  "block-objective",
  "counter-circle",
  "counter-reverse",
  "bait-ram",
  "ignore-decoy",
  "recover",
]);

export const HUNTER_TACTIC_LABELS = Object.freeze({
  pressure: "давит напрямую",
  intercept: "режет курс",
  "flank-left": "заходит слева",
  "flank-right": "заходит справа",
  "block-objective": "перекрывает путь",
  "counter-circle": "ломает круговой манёвр",
  "counter-reverse": "ловит задний ход",
  "bait-ram": "уклоняется от тарана",
  "ignore-decoy": "распознал ложный буй",
  recover: "перестраивается",
  decoy: "идёт к ложному бую",
  disabled: "выведен из строя",
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rad = value => value * Math.PI / 180;
const deg = value => value * 180 / Math.PI;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const smooth = (current, target, dt, rate) => current + (target - current) * Math.min(1, dt * rate);

function seededRandom(seed = 1) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function createRandomHunterWeights(seed = 125552) {
  const random = seededRandom(seed);
  const layer = (output, input) => Array.from({length: output * input}, () => (random() * 2 - 1) * Math.sqrt(2 / input));
  return {
    version: 1,
    input: HUNTER_FEATURE_COUNT,
    hidden1: HUNTER_HIDDEN_ONE,
    hidden2: HUNTER_HIDDEN_TWO,
    output: HUNTER_TACTICS.length,
    w1: layer(HUNTER_HIDDEN_ONE, HUNTER_FEATURE_COUNT),
    b1: Array(HUNTER_HIDDEN_ONE).fill(0),
    w2: layer(HUNTER_HIDDEN_TWO, HUNTER_HIDDEN_ONE),
    b2: Array(HUNTER_HIDDEN_TWO).fill(0),
    w3: layer(HUNTER_TACTICS.length, HUNTER_HIDDEN_TWO),
    b3: Array(HUNTER_TACTICS.length).fill(0),
  };
}

function validWeights(value) {
  return Boolean(value
    && value.input === HUNTER_FEATURE_COUNT
    && value.hidden1 === HUNTER_HIDDEN_ONE
    && value.hidden2 === HUNTER_HIDDEN_TWO
    && value.output === HUNTER_TACTICS.length
    && value.w1?.length === HUNTER_FEATURE_COUNT * HUNTER_HIDDEN_ONE
    && value.w2?.length === HUNTER_HIDDEN_ONE * HUNTER_HIDDEN_TWO
    && value.w3?.length === HUNTER_HIDDEN_TWO * HUNTER_TACTICS.length);
}

export function activeHunterWeights() {
  return validWeights(HUNTER_BRAIN_WEIGHTS) ? HUNTER_BRAIN_WEIGHTS : createRandomHunterWeights();
}

function dense(input, weights, bias, outputSize, activation = Math.tanh) {
  const inputSize = input.length;
  const output = Array(outputSize);
  for (let row = 0; row < outputSize; row += 1) {
    let sum = Number(bias[row]) || 0;
    const offset = row * inputSize;
    for (let column = 0; column < inputSize; column += 1) sum += input[column] * weights[offset + column];
    output[row] = activation ? activation(sum) : sum;
  }
  return output;
}

function softmax(logits) {
  const maximum = Math.max(...logits);
  const values = logits.map(value => Math.exp(value - maximum));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  return values.map(value => value / total);
}

export function runHunterNetwork(features, weights = activeHunterWeights()) {
  const h1 = dense(features, weights.w1, weights.b1, weights.hidden1);
  const h2 = dense(h1, weights.w2, weights.b2, weights.hidden2);
  const logits = dense(h2, weights.w3, weights.b3, weights.output, null);
  return {h1, h2, logits, probabilities: softmax(logits)};
}

export function trainHunterSample(weights, features, labelIndex, learningRate = 0.018) {
  const {h1, h2, probabilities} = runHunterNetwork(features, weights);
  const d3 = [...probabilities];
  d3[labelIndex] -= 1;

  const d2 = Array(weights.hidden2).fill(0);
  for (let hidden = 0; hidden < weights.hidden2; hidden += 1) {
    let sum = 0;
    for (let output = 0; output < weights.output; output += 1) {
      sum += weights.w3[output * weights.hidden2 + hidden] * d3[output];
    }
    d2[hidden] = sum * (1 - h2[hidden] * h2[hidden]);
  }

  const d1 = Array(weights.hidden1).fill(0);
  for (let hidden = 0; hidden < weights.hidden1; hidden += 1) {
    let sum = 0;
    for (let output = 0; output < weights.hidden2; output += 1) {
      sum += weights.w2[output * weights.hidden1 + hidden] * d2[output];
    }
    d1[hidden] = sum * (1 - h1[hidden] * h1[hidden]);
  }

  for (let output = 0; output < weights.output; output += 1) {
    const offset = output * weights.hidden2;
    for (let hidden = 0; hidden < weights.hidden2; hidden += 1) {
      weights.w3[offset + hidden] -= learningRate * d3[output] * h2[hidden];
    }
    weights.b3[output] -= learningRate * d3[output];
  }
  for (let output = 0; output < weights.hidden2; output += 1) {
    const offset = output * weights.hidden1;
    for (let hidden = 0; hidden < weights.hidden1; hidden += 1) {
      weights.w2[offset + hidden] -= learningRate * d2[output] * h1[hidden];
    }
    weights.b2[output] -= learningRate * d2[output];
  }
  for (let output = 0; output < weights.hidden1; output += 1) {
    const offset = output * weights.input;
    for (let input = 0; input < weights.input; input += 1) {
      weights.w1[offset + input] -= learningRate * d1[output] * features[input];
    }
    weights.b1[output] -= learningRate * d1[output];
  }
  return -Math.log(Math.max(1e-8, probabilities[labelIndex]));
}

export function featureVectorFromSnapshot(snapshot = {}) {
  return [
    clamp((snapshot.distance || 0) / 160, 0, 1),
    clamp((snapshot.relativeAngle || 0) / 180, -1, 1),
    clamp(Math.abs(snapshot.playerSpeed || 0) / 36, 0, 1),
    clamp(Math.abs(snapshot.hunterSpeed || 0) / 30, 0, 1),
    clamp(((snapshot.playerSpeed || 0) - (snapshot.hunterSpeed || 0)) / 36, -1, 1),
    clamp(Math.abs(snapshot.turnRate || 0) / 120, 0, 1),
    clamp(snapshot.turnDirection || 0, -1, 1),
    clamp(snapshot.turnPersistence || 0, 0, 1),
    clamp(snapshot.reversePersistence || 0, 0, 1),
    clamp(snapshot.stationaryPersistence || 0, 0, 1),
    clamp((snapshot.playerHull ?? 100) / 100, 0, 1),
    clamp((snapshot.hunterHull ?? 100) / 100, 0, 1),
    snapshot.decoyActive ? 1 : 0,
    clamp(snapshot.decoySuspicion || 0, 0, 1),
    clamp(snapshot.ramBait || 0, 0, 1),
    clamp((snapshot.objectiveDistance || 0) / 320, 0, 1),
    clamp((snapshot.failedAttacks || 0) / 4, 0, 1),
    clamp((snapshot.playerLedHits || 0) / 3, 0, 1),
  ];
}

function objectiveFor(state) {
  const locked = state.world?.survivors?.find(item => item.id === state.navigation?.lockedTargetId && !item.rescued);
  if (locked) return locked;
  const remaining = (state.world?.survivors || [])
    .filter(item => !item.rescued)
    .sort((left, right) => distance(state.boat, left) - distance(state.boat, right));
  return remaining[0] || state.world?.harbor || state.boat;
}

function hunterRelativeAngle(state) {
  const absolute = deg(Math.atan2(state.hunter.x - state.boat.x, state.hunter.y - state.boat.y));
  return wrapDeg(absolute - state.boat.heading);
}

export function ensureHunterBrain(state) {
  state.hunter ||= {};
  state.hunter.brain ||= {};
  const brain = state.hunter.brain;
  if (brain.version !== 1) {
    Object.assign(brain, {
      version: 1,
      tactic: "pressure",
      confidence: 0,
      nextDecisionAt: 0,
      previousHeading: Number(state.boat?.heading) || 0,
      turnRate: 0,
      turnDirection: 0,
      turnPersistence: 0,
      reversePersistence: 0,
      stationaryPersistence: 0,
      ramBait: 0,
      decoySuspicion: 0,
      decoyUses: 0,
      failedAttacks: 0,
      playerLedHits: 0,
      successfulRams: 0,
      lastDecisionAt: 0,
      tacticHistory: [],
      probabilities: Array(HUNTER_TACTICS.length).fill(0),
    });
  }
  if (!Array.isArray(brain.tacticHistory)) brain.tacticHistory = [];
  if (!Array.isArray(brain.probabilities)) brain.probabilities = Array(HUNTER_TACTICS.length).fill(0);
  return brain;
}

export function updateHunterBrainMemory(state, dt, now) {
  const brain = ensureHunterBrain(state);
  const heading = Number(state.boat.heading) || 0;
  const headingDelta = wrapDeg(heading - brain.previousHeading);
  const turnRate = dt > 0 ? headingDelta / dt : 0;
  brain.previousHeading = heading;
  brain.turnRate = smooth(brain.turnRate, turnRate, dt, 4.2);
  const turnDirection = Math.abs(brain.turnRate) > 8 ? Math.sign(brain.turnRate) : 0;
  brain.turnDirection = smooth(brain.turnDirection, turnDirection, dt, 3.2);
  brain.turnPersistence = clamp(brain.turnPersistence + dt * (turnDirection ? 0.55 : -0.8), 0, 1);
  brain.reversePersistence = clamp(brain.reversePersistence + dt * (state.boat.speed < -0.35 ? 0.72 : -0.9), 0, 1);
  brain.stationaryPersistence = clamp(brain.stationaryPersistence + dt * (Math.abs(state.boat.speed) < 0.3 ? 0.65 : -1), 0, 1);
  const relative = hunterRelativeAngle(state);
  const hunterInBow = Math.abs(relative) < 24;
  const deliberateClosing = hunterInBow && state.boat.speed > 7.5 && distance(state.hunter, state.boat) < 42;
  brain.ramBait = smooth(brain.ramBait, deliberateClosing ? 1 : 0, dt, deliberateClosing ? 2.8 : 0.7);
  brain.decoySuspicion = clamp(brain.decoySuspicion - dt * 0.012, 0, 1);
  brain.failedAttacks = clamp(brain.failedAttacks - dt * 0.008, 0, 4);
  brain.playerLedHits = clamp(brain.playerLedHits - dt * 0.006, 0, 3);
  brain.lastMemoryAt = now;
  return brain;
}

export function buildHunterFeatures(state) {
  const brain = ensureHunterBrain(state);
  const objective = objectiveFor(state);
  return featureVectorFromSnapshot({
    distance: distance(state.hunter, state.boat),
    relativeAngle: hunterRelativeAngle(state),
    playerSpeed: state.boat.speed,
    hunterSpeed: state.hunter.speed,
    turnRate: brain.turnRate,
    turnDirection: brain.turnDirection,
    turnPersistence: brain.turnPersistence,
    reversePersistence: brain.reversePersistence,
    stationaryPersistence: brain.stationaryPersistence,
    playerHull: state.boat.hull,
    hunterHull: state.hunter.hull,
    decoyActive: state.hunter.decoyUntil > (state.totalElapsed ?? state.elapsed ?? 0),
    decoySuspicion: brain.decoySuspicion,
    ramBait: brain.ramBait,
    objectiveDistance: distance(state.boat, objective),
    failedAttacks: brain.failedAttacks,
    playerLedHits: brain.playerLedHits,
  });
}

function addBias(logits, tactic, amount) {
  const index = HUNTER_TACTICS.indexOf(tactic);
  if (index >= 0) logits[index] += amount;
}

export function chooseHunterTactic(state, now, force = false) {
  const brain = ensureHunterBrain(state);
  if (!force && now < brain.nextDecisionAt) return {tactic: brain.tactic, confidence: brain.confidence, changed: false};
  const features = buildHunterFeatures(state);
  const network = runHunterNetwork(features);
  const logits = [...network.logits];
  const playerSpeedAdvantage = features[4];
  const distanceFeature = features[0];

  if (brain.stationaryPersistence > 0.42) addBias(logits, "pressure", 1.8);
  if (brain.reversePersistence > 0.32) addBias(logits, "counter-reverse", 2.7);
  if (brain.turnPersistence > 0.38 && Math.abs(brain.turnDirection) > 0.35) {
    addBias(logits, "counter-circle", 6.2);
    addBias(logits, "pressure", -1.6);
    addBias(logits, "intercept", -0.8);
  }
  if (brain.ramBait > 0.36 || brain.playerLedHits > 0.65) addBias(logits, "bait-ram", 2.9);
  if (playerSpeedAdvantage > 0.08) {
    addBias(logits, "block-objective", 2.4);
    addBias(logits, "intercept", 1.1);
  }
  if (state.hunter.decoyUntil > now && brain.decoySuspicion > 0.48) addBias(logits, "ignore-decoy", 3.1);
  if (distanceFeature > 0.7) addBias(logits, playerSpeedAdvantage > 0.05 ? "block-objective" : "intercept", 1.8);
  if (state.hunter.hull / Math.max(1, state.hunter.maxHull) < 0.28) addBias(logits, "recover", 1.8);
  if (brain.failedAttacks > 1.4) {
    addBias(logits, brain.turnPersistence > 0.3 ? "counter-circle" : "flank-left", 1.2);
    addBias(logits, "pressure", -1.4);
  }

  const probabilities = softmax(logits);
  let best = 0;
  for (let index = 1; index < probabilities.length; index += 1) {
    if (probabilities[index] > probabilities[best]) best = index;
  }
  const tactic = HUNTER_TACTICS[best];
  const changed = tactic !== brain.tactic;
  brain.tactic = tactic;
  brain.confidence = probabilities[best];
  brain.probabilities = probabilities;
  brain.lastDecisionAt = now;
  brain.nextDecisionAt = now + clamp(1.15 - brain.confidence * 0.5, 0.58, 1.05);
  if (changed) {
    brain.tacticHistory.push({time: now, tactic, confidence: brain.confidence});
    if (brain.tacticHistory.length > 24) brain.tacticHistory.shift();
  }
  state.hunter.mode = tactic;
  return {tactic, confidence: brain.confidence, changed, features, probabilities};
}

function playerVelocity(state) {
  const heading = rad(state.boat.heading);
  return {x: Math.sin(heading) * state.boat.speed, y: Math.cos(heading) * state.boat.speed};
}

function leadPoint(state, seconds, lateral = 0) {
  const velocity = playerVelocity(state);
  const heading = rad(state.boat.heading + 90);
  return {
    x: state.boat.x + velocity.x * seconds + Math.sin(heading) * lateral,
    y: state.boat.y + velocity.y * seconds + Math.cos(heading) * lateral,
    decoy: false,
  };
}

export function hunterTacticalTarget(state, now) {
  const brain = ensureHunterBrain(state);
  const tactic = brain.tactic || "pressure";
  const metres = distance(state.hunter, state.boat);
  const decoyActive = state.hunter.decoyUntil > now;
  if (decoyActive && tactic !== "ignore-decoy" && brain.decoySuspicion < 0.72) {
    return {x: state.hunter.decoyX, y: state.hunter.decoyY, decoy: true};
  }
  if (tactic === "recover") {
    const dx = state.hunter.x - state.boat.x;
    const dy = state.hunter.y - state.boat.y;
    const length = Math.hypot(dx, dy) || 1;
    return {x: state.hunter.x + dx / length * 55, y: state.hunter.y + dy / length * 55, decoy: false};
  }
  if (tactic === "block-objective") {
    const objective = objectiveFor(state);
    const dx = objective.x - state.boat.x;
    const dy = objective.y - state.boat.y;
    const length = Math.hypot(dx, dy) || 1;
    const blockDistance = clamp(length * 0.42, 32, 82);
    return {x: state.boat.x + dx / length * blockDistance, y: state.boat.y + dy / length * blockDistance, decoy: false};
  }
  if (tactic === "counter-circle") {
    const side = Math.sign(brain.turnDirection || 1);
    const angle = rad(state.boat.heading + side * 90);
    const inward = clamp(16 + Math.abs(state.boat.speed) * 0.45, 16, 28);
    return {
      x: state.boat.x + Math.sin(angle) * inward + playerVelocity(state).x * 0.45,
      y: state.boat.y + Math.cos(angle) * inward + playerVelocity(state).y * 0.45,
      decoy: false,
    };
  }
  if (tactic === "counter-reverse") return leadPoint(state, clamp(metres / 28, 0.55, 1.25), brain.turnDirection * 10);
  if (tactic === "bait-ram") {
    const side = hunterRelativeAngle(state) < 0 ? 1 : -1;
    return leadPoint(state, 0.22, side * 31);
  }
  if (tactic === "flank-left") return leadPoint(state, clamp(metres / 24, 0.65, 1.7), -27);
  if (tactic === "flank-right") return leadPoint(state, clamp(metres / 24, 0.65, 1.7), 27);
  if (tactic === "intercept" || tactic === "ignore-decoy") return leadPoint(state, clamp(metres / 17, 0.8, 2.2));
  return leadPoint(state, clamp(metres / 23, 0.45, 1.45));
}

export function hunterTacticSpeedScale(tactic) {
  return ({
    pressure: 1,
    intercept: 1,
    "flank-left": 0.94,
    "flank-right": 0.94,
    "block-objective": 1,
    "counter-circle": 0.9,
    "counter-reverse": 0.96,
    "bait-ram": 0.84,
    "ignore-decoy": 1,
    recover: 0.68,
  })[tactic] || 1;
}

export function noteHunterDecoy(state) {
  const brain = ensureHunterBrain(state);
  brain.decoyUses += 1;
  brain.decoySuspicion = clamp(brain.decoySuspicion + (brain.decoyUses === 1 ? 0.34 : 0.62), 0, 1);
  brain.nextDecisionAt = 0;
}

export function noteHunterOutcome(state, kind, details = {}) {
  const brain = ensureHunterBrain(state);
  if (kind === "hunter-hit") {
    brain.playerLedHits = clamp(brain.playerLedHits + 1, 0, 3);
    brain.failedAttacks = clamp(brain.failedAttacks + 1.2, 0, 4);
    brain.ramBait = clamp(brain.ramBait + 0.55, 0, 1);
  } else if (kind === "hunter-ram") {
    brain.successfulRams += 1;
    brain.failedAttacks = clamp(brain.failedAttacks - 0.8, 0, 4);
    brain.ramBait = clamp(brain.ramBait - 0.25, 0, 1);
  } else if (kind === "miss") {
    brain.failedAttacks = clamp(brain.failedAttacks + (details.amount || 0.3), 0, 4);
  }
  brain.nextDecisionAt = 0;
}

export function hunterTacticLabel(state, now) {
  if (state.hunter?.destroyed) return HUNTER_TACTIC_LABELS.disabled;
  const brain = ensureHunterBrain(state);
  if (state.hunter.decoyUntil > now && brain.tactic !== "ignore-decoy" && brain.decoySuspicion < 0.72) {
    return HUNTER_TACTIC_LABELS.decoy;
  }
  return HUNTER_TACTIC_LABELS[brain.tactic] || HUNTER_TACTIC_LABELS.pressure;
}

export function serializeHunterWeights(weights) {
  const round = values => values.map(value => Number(value.toFixed(7)));
  const clean = {
    ...weights,
    w1: round(weights.w1), b1: round(weights.b1),
    w2: round(weights.w2), b2: round(weights.b2),
    w3: round(weights.w3), b3: round(weights.b3),
  };
  return `"use strict";\n\nexport const HUNTER_BRAIN_WEIGHTS = ${JSON.stringify(clean)};\n`;
}
