"use strict";

const CUSTOM_ENGINE_PROFILE_PREFIXES = Object.freeze([
  "dual-turret",
  "stress-50-engine",
  "medium-crew",
]);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const wrapDeg = value => ((Number(value) + 180) % 360 + 360) % 360 - 180;

export function vesselUsesCustomEngineAudio(boat) {
  if (!boat) return false;
  const explicitAuthority = String(boat.vesselAudioAuthority || "").trim();
  if (explicitAuthority) return explicitAuthority !== "legacy";
  const profile = String(boat.audioProfile || "standard").trim();
  return CUSTOM_ENGINE_PROFILE_PREFIXES.some(prefix => profile.startsWith(prefix));
}

export function relativeVesselPan(listener, source) {
  if (!listener || !source) return 0;
  const dx = (Number(source.x) || 0) - (Number(listener.x) || 0);
  const dy = (Number(source.y) || 0) - (Number(listener.y) || 0);
  const metres = Math.hypot(dx, dy);
  if (metres < 0.001) return 0;

  // All spatial vessel audio is listener-relative. World X is not "right" once
  // the listener has turned. Using heading here keeps a physical boat in the
  // same perceived direction as its actual server coordinates on foot, while
  // swimming, or from another vessel.
  const absoluteBearing = Math.atan2(dx, -dy) * 180 / Math.PI;
  const relativeBearing = wrapDeg(absoluteBearing - (Number(listener.heading) || 0));
  return clamp(Math.sin(relativeBearing * Math.PI / 180), -1, 1);
}
