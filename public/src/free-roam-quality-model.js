"use strict";

export const LIGHTWEIGHT_FRAME_INTERVAL_MS = 67;
export const LIGHTWEIGHT_ACK_DELAY_MS = 85;

export function resolveLightweightPreference({
  storedPreference = "",
  hardwareConcurrency = 0,
  deviceMemory = 0,
  reducedMotion = false,
} = {}) {
  const stored = String(storedPreference || "").toLowerCase();
  if (stored === "on") return true;
  if (stored === "off") return false;

  const cores = Number(hardwareConcurrency) || 0;
  const memory = Number(deviceMemory) || 0;
  return Boolean(
    reducedMotion
    || (cores > 0 && cores <= 4)
    || (memory > 0 && memory <= 4)
  );
}

export function isFreeStateAckPayload(payload) {
  if (typeof payload !== "string") return false;
  try {
    return JSON.parse(payload)?.type === "free-state-ack";
  } catch (_) {
    return false;
  }
}
