"use strict";

import {
  HUNTER_TACTICS,
  createRandomHunterWeights,
  featureVectorFromSnapshot,
  runHunterNetwork,
  serializeHunterWeights,
  trainHunterSample,
} from "./hunter-brain.js?v=25.0";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rad = value => value * Math.PI / 180;
const wrapDeg = value => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function seededRandom(seed = 1) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export const VIRTUAL_PLAYER_PROFILES = Object.freeze([
  Object.freeze({id: "idle", label: "стоит на месте", tactic: "pressure"}),
  Object.freeze({id: "reverse", label: "долго идёт назад", tactic: "counter-reverse"}),
  Object.freeze({id: "straight", label: "уходит прямо", tactic: "intercept"}),
  Object.freeze({id: "grom-escape", label: "быстрый Гром уходит к цели", tactic: "block-objective"}),
  Object.freeze({id: "ram-bait", label: "разворачивает нос и таранит", tactic: "bait-ram"}),
  Object.freeze({id: "circle-left", label: "кружит влево", tactic: "counter-circle"}),
  Object.freeze({id: "circle-right", label: "кружит вправо", tactic: "counter-circle"}),
  Object.freeze({id: "zigzag-left", label: "ломает курс влево", tactic: "flank-right"}),
  Object.freeze({id: "zigzag-right", label: "ломает курс вправо", tactic: "flank-left"}),
  Object.freeze({id: "repeat-decoy", label: "повторно сбрасывает ложный буй", tactic: "ignore-decoy"}),
  Object.freeze({id: "damaged-hunter", label: "добивает повреждённого преследователя", tactic: "recover"}),
]);

function policy(profile, time, random) {
  const noise = (random() * 2 - 1) * 0.08;
  switch (profile.id) {
    case "idle": return {speed: 0, turn: 0, decoy: false, ram: 0};
    case "reverse": return {speed: -4.2 + noise, turn: Math.sin(time * 0.7) * 0.08, decoy: false, ram: 0};
    case "straight": return {speed: 17 + noise * 4, turn: 0, decoy: false, ram: 0};
    case "grom-escape": return {speed: 32 + noise * 3, turn: Math.sin(time * 0.35) * 0.03, decoy: false, ram: 0};
    case "ram-bait": return {speed: 13.5 + noise * 3, turn: Math.sin(time * 0.9) * 0.11, decoy: false, ram: 1};
    case "circle-left": return {speed: 11 + noise * 2, turn: -0.82, decoy: false, ram: 0.1};
    case "circle-right": return {speed: 11 + noise * 2, turn: 0.82, decoy: false, ram: 0.1};
    case "zigzag-left": return {speed: 15 + noise * 3, turn: Math.sin(time * 2.5) < 0 ? -0.75 : -0.15, decoy: false, ram: 0};
    case "zigzag-right": return {speed: 15 + noise * 3, turn: Math.sin(time * 2.5) > 0 ? 0.75 : 0.15, decoy: false, ram: 0};
    case "repeat-decoy": return {speed: 18 + noise * 2, turn: Math.sin(time) * 0.08, decoy: time > 1, ram: 0};
    case "damaged-hunter": return {speed: 12 + noise * 2, turn: Math.sin(time * 0.8) * 0.2, decoy: false, ram: 0.35};
    default: return {speed: 12, turn: 0, decoy: false, ram: 0};
  }
}

function simulateProfile(profile, random, episodeIndex, steps = 84, dt = 0.12) {
  const player = {x: 0, y: 0, heading: (random() * 70 - 35), speed: 0};
  const hunter = {x: -35 - random() * 30, y: -20 + random() * 30, heading: 20, speed: 10};
  const objective = {x: (random() * 2 - 1) * 70, y: 220 + random() * 80};
  let previousHeading = player.heading;
  let turnPersistence = 0;
  let reversePersistence = 0;
  let stationaryPersistence = 0;
  let decoySuspicion = profile.id === "repeat-decoy" ? 0.62 + random() * 0.28 : random() * 0.08;
  let failedAttacks = profile.id.includes("circle") ? 1.2 : profile.id === "ram-bait" ? 1.7 : 0;
  let playerLedHits = profile.id === "ram-bait" ? 1.1 + random() * 1.2 : 0;
  const samples = [];

  for (let step = 0; step < steps; step += 1) {
    const time = step * dt;
    const action = policy(profile, time, random);
    player.speed += (action.speed - player.speed) * Math.min(1, dt * 4.2);
    player.heading = wrapDeg(player.heading + action.turn * dt * 78);
    const heading = rad(player.heading);
    player.x += Math.sin(heading) * player.speed * dt;
    player.y += Math.cos(heading) * player.speed * dt;

    const aim = Math.atan2(player.x - hunter.x, player.y - hunter.y) * 180 / Math.PI;
    hunter.heading = wrapDeg(hunter.heading + clamp(wrapDeg(aim - hunter.heading), -88 * dt, 88 * dt));
    hunter.speed += (24 - hunter.speed) * Math.min(1, dt * 1.1);
    const hunterHeading = rad(hunter.heading);
    hunter.x += Math.sin(hunterHeading) * hunter.speed * dt;
    hunter.y += Math.cos(hunterHeading) * hunter.speed * dt;

    const headingDelta = wrapDeg(player.heading - previousHeading);
    previousHeading = player.heading;
    const turnRate = headingDelta / dt;
    const direction = Math.abs(turnRate) > 8 ? Math.sign(turnRate) : 0;
    turnPersistence = clamp(turnPersistence + dt * (direction ? 0.55 : -0.8), 0, 1);
    reversePersistence = clamp(reversePersistence + dt * (player.speed < -0.35 ? 0.72 : -0.9), 0, 1);
    stationaryPersistence = clamp(stationaryPersistence + dt * (Math.abs(player.speed) < 0.3 ? 0.65 : -1), 0, 1);
    decoySuspicion = clamp(decoySuspicion + (action.decoy ? dt * 0.12 : -dt * 0.01), 0, 1);

    const absolute = Math.atan2(hunter.x - player.x, hunter.y - player.y) * 180 / Math.PI;
    const relativeAngle = wrapDeg(absolute - player.heading);
    const snapshot = {
      distance: distance(player, hunter),
      relativeAngle,
      playerSpeed: player.speed,
      hunterSpeed: hunter.speed,
      turnRate,
      turnDirection: direction,
      turnPersistence,
      reversePersistence,
      stationaryPersistence,
      playerHull: 72 + random() * 28,
      hunterHull: profile.id === "damaged-hunter" ? 12 + random() * 14 : 62 + random() * 38,
      decoyActive: action.decoy,
      decoySuspicion,
      ramBait: action.ram,
      objectiveDistance: distance(player, objective),
      failedAttacks,
      playerLedHits,
    };
    if (step > 8) {
      samples.push({
        features: featureVectorFromSnapshot(snapshot),
        label: HUNTER_TACTICS.indexOf(profile.tactic),
        profile: profile.id,
        episode: episodeIndex,
      });
    }
    failedAttacks = clamp(failedAttacks - dt * 0.01, 0, 4);
    playerLedHits = clamp(playerLedHits - dt * 0.006, 0, 3);
  }
  return samples;
}

function shuffle(values, random) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

export function buildVirtualPlayerCorpus({seed = 20260714, episodesPerProfile = 5} = {}) {
  const random = seededRandom(seed);
  const samples = [];
  const episodes = [];
  for (const profile of VIRTUAL_PLAYER_PROFILES) {
    for (let episode = 0; episode < episodesPerProfile; episode += 1) {
      const generated = simulateProfile(profile, random, episode);
      samples.push(...generated);
      episodes.push({profile: profile.id, samples: generated.length});
    }
  }
  return {samples: shuffle(samples, random), episodes};
}

function predictedIndex(weights, features) {
  const probabilities = runHunterNetwork(features, weights).probabilities;
  let best = 0;
  for (let index = 1; index < probabilities.length; index += 1) {
    if (probabilities[index] > probabilities[best]) best = index;
  }
  return best;
}

function evaluate(weights, samples) {
  let correct = 0;
  const byProfile = {};
  for (const sample of samples) {
    const predicted = predictedIndex(weights, sample.features);
    const bucket = byProfile[sample.profile] ||= {correct: 0, total: 0, tactics: {}};
    bucket.total += 1;
    bucket.tactics[HUNTER_TACTICS[predicted]] = (bucket.tactics[HUNTER_TACTICS[predicted]] || 0) + 1;
    if (predicted === sample.label) {
      correct += 1;
      bucket.correct += 1;
    }
  }
  for (const bucket of Object.values(byProfile)) bucket.accuracy = bucket.total ? bucket.correct / bucket.total : 0;
  return {accuracy: samples.length ? correct / samples.length : 0, correct, total: samples.length, byProfile};
}

export function trainVirtualHunter({seed = 20260714, epochs = 22, episodesPerProfile = 5, learningRate = 0.016} = {}) {
  const random = seededRandom(seed ^ 0x5f3759df);
  const {samples, episodes} = buildVirtualPlayerCorpus({seed, episodesPerProfile});
  const split = Math.floor(samples.length * 0.82);
  const training = samples.slice(0, split);
  const validation = samples.slice(split);
  const weights = createRandomHunterWeights(seed);
  const losses = [];

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    shuffle(training, random);
    let loss = 0;
    const rate = learningRate * (1 - epoch / epochs * 0.55);
    for (const sample of training) loss += trainHunterSample(weights, sample.features, sample.label, rate);
    losses.push(loss / Math.max(1, training.length));
  }

  const trainingReport = evaluate(weights, training);
  const validationReport = evaluate(weights, validation);
  return {
    weights,
    moduleSource: serializeHunterWeights(weights),
    report: {
      architecture: `${weights.input}-${weights.hidden1}-${weights.hidden2}-${weights.output}`,
      parameterCount: weights.w1.length + weights.b1.length + weights.w2.length + weights.b2.length + weights.w3.length + weights.b3.length,
      episodes,
      samples: samples.length,
      losses,
      training: trainingReport,
      validation: validationReport,
    },
  };
}
