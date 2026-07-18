"use strict";

export function oppositeRole(role) {
  return role === "captain" ? "crew" : "captain";
}

export function chooseWaitingRoom(rooms, role, mode = "ops") {
  const opposite = oppositeRole(role);
  return [...rooms.values()]
    .filter(room => (room.mode || "ops") === mode)
    .filter(room => !room[role] && Boolean(room[opposite]))
    .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
}

export function createRoomCode(randomValues = null, prefix = "SEA") {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = randomValues || crypto.getRandomValues(new Uint32Array(5));
  const suffix = [...values].slice(0, 5).map(value => alphabet[value % alphabet.length]).join("");
  return `${prefix}-${suffix}`;
}

export function publicRoomList(rooms, now = Date.now(), mode = null) {
  return [...rooms.values()]
    .filter(room => mode == null || (room.mode || "ops") === mode)
    .filter(room => Boolean(room.captain) !== Boolean(room.crew))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(room => ({
      id: room.id,
      mode: room.mode || "ops",
      waitingFor: room.captain ? "crew" : "captain",
      ageSeconds: Math.max(0, Math.floor((now - room.createdAt) / 1000)),
    }));
}
