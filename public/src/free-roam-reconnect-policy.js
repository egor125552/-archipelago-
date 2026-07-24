"use strict";

export const RECONNECT_DELAYS_MS = Object.freeze([400, 900, 1_600, 2_800, 4_500, 7_000, 10_000]);
export const SERVER_SILENCE_LIMIT_MS = 14_000;

export function reconnectDelay(attempt) {
  const index = Math.max(0, Math.min(Number(attempt) || 0, RECONNECT_DELAYS_MS.length - 1));
  return RECONNECT_DELAYS_MS[index];
}

export function shouldExpireSilentConnection({now, lastServerMessageAt, gameVisible = true}) {
  if (!gameVisible || !Number.isFinite(lastServerMessageAt) || lastServerMessageAt <= 0) return false;
  return Math.max(0, Number(now) || 0) - lastServerMessageAt >= SERVER_SILENCE_LIMIT_MS;
}

export function reconnectLobbyMatches({targetRoom, requestedRole, message}) {
  if (!targetRoom) return true;
  return Boolean(
    message
    && message.room === targetRoom
    && message.role === requestedRole
    && (message.preferredRoomFound === true || message.recreatedRoom === true)
  );
}
