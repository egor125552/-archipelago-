"use strict";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -30, 30)));

function decodeBase64(value) {
  if (typeof Buffer !== "undefined") return new Int8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Int8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) << 24 >> 24;
  return bytes;
}

function tensor(specification) {
  if (!specification?.shape || !specification?.data || !Number.isFinite(specification.scale)) {
    throw new TypeError("Invalid quantized tactical-policy tensor");
  }
  const size = specification.shape.reduce((product, value) => product * value, 1);
  const values = decodeBase64(specification.data);
  if (values.length !== size) throw new RangeError(`Tensor size ${values.length} does not match ${size}`);
  return {shape: specification.shape, scale: specification.scale, values};
}

function affine(matrix, bias, input) {
  const rows = matrix.shape[0];
  const columns = matrix.shape[1];
  if (input.length !== columns || bias.shape[0] !== rows) throw new RangeError("Tactical-policy affine shape mismatch");
  const output = new Float32Array(rows);
  for (let row = 0; row < rows; row += 1) {
    let total = bias.values[row] * bias.scale;
    const offset = row * columns;
    for (let column = 0; column < columns; column += 1) {
      total += matrix.values[offset + column] * matrix.scale * input[column];
    }
    output[row] = total;
  }
  return output;
}

function softmax(logits) {
  let maximum = -Infinity;
  for (const value of logits) maximum = Math.max(maximum, value);
  const output = new Float32Array(logits.length);
  let total = 0;
  for (let index = 0; index < logits.length; index += 1) {
    output[index] = Math.exp(logits[index] - maximum);
    total += output[index];
  }
  if (total <= 0) return output;
  for (let index = 0; index < output.length; index += 1) output[index] /= total;
  return output;
}

function maximumIndex(values) {
  let result = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] > values[result]) result = index;
  return result;
}

export function createTacticalPolicyRuntime(model) {
  if (!model || !Number.isInteger(model.inputSize) || !Number.isInteger(model.hiddenSize)) {
    throw new TypeError("Invalid tactical-policy model");
  }
  const weights = Object.fromEntries(Object.entries(model.weights || {}).map(([name, value]) => [name, tensor(value)]));
  const hiddenSize = model.hiddenSize;
  if (weights.gruWeightIH.shape[0] !== hiddenSize * 3 || weights.gruWeightHH.shape[0] !== hiddenSize * 3) {
    throw new RangeError("Unsupported GRU gate layout");
  }

  function step(rawFeatures, rawHidden = null) {
    if (!rawFeatures || rawFeatures.length !== model.inputSize) throw new RangeError(`Expected ${model.inputSize} policy features`);
    const features = Float32Array.from(rawFeatures, value => Number.isFinite(value) ? value : 0);
    const previous = rawHidden
      ? Float32Array.from(rawHidden, value => Number.isFinite(value) ? value : 0)
      : new Float32Array(hiddenSize);
    if (previous.length !== hiddenSize) throw new RangeError(`Expected ${hiddenSize} hidden values`);

    const inputGates = affine(weights.gruWeightIH, weights.gruBiasIH, features);
    const hiddenGates = affine(weights.gruWeightHH, weights.gruBiasHH, previous);
    const next = new Float32Array(hiddenSize);
    for (let index = 0; index < hiddenSize; index += 1) {
      const reset = sigmoid(inputGates[index] + hiddenGates[index]);
      const update = sigmoid(inputGates[hiddenSize + index] + hiddenGates[hiddenSize + index]);
      const candidate = Math.tanh(inputGates[hiddenSize * 2 + index] + reset * hiddenGates[hiddenSize * 2 + index]);
      next[index] = (1 - update) * candidate + update * previous[index];
    }

    const movementLogits = affine(weights.movementWeight, weights.movementBias, next);
    const fireLogits = affine(weights.fireWeight, weights.fireBias, next);
    const movementProbabilities = softmax(movementLogits);
    const fireProbabilities = softmax(fireLogits);
    const movementIndex = maximumIndex(movementProbabilities);
    return {
      hidden: next,
      movementIndex,
      movement: model.movementClasses[movementIndex] || "hold",
      movementConfidence: movementProbabilities[movementIndex] || 0,
      movementProbabilities,
      movementLogits,
      fire: fireProbabilities[1] >= 0.5,
      fireProbability: fireProbabilities[1] || 0,
      fireLogits,
    };
  }

  return Object.freeze({model, step});
}

export function verifyTacticalPolicyGolden(model, tolerance = model?.golden?.maximumAbsoluteTolerance ?? 0.04) {
  const runtime = createTacticalPolicyRuntime(model);
  const result = runtime.step(model.golden.input);
  const pairs = [
    [result.hidden, model.golden.hidden, "hidden"],
    [result.movementLogits, model.golden.movementLogits, "movement"],
    [result.fireLogits, model.golden.fireLogits, "fire"],
  ];
  let maximumError = 0;
  for (const [actual, expected, name] of pairs) {
    if (actual.length !== expected.length) throw new RangeError(`${name} golden length mismatch`);
    for (let index = 0; index < actual.length; index += 1) maximumError = Math.max(maximumError, Math.abs(actual[index] - expected[index]));
  }
  return {ok: maximumError <= tolerance, maximumError, tolerance};
}
