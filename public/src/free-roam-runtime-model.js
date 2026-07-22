"use strict";

export const AUDIO_INTERVAL_MS = 33;

export function createChangeGate(initialValue = "") {
  let current = String(initialValue ?? "");
  return {
    shouldCommit(nextValue) {
      const next = String(nextValue ?? "");
      if (next === current) return false;
      current = next;
      return true;
    },
    current: () => current,
  };
}

export function isPredictionFrame(callback) {
  return typeof callback === "function" && callback.name === "frame";
}
