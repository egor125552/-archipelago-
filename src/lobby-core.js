"use strict";

export function oppositeRole(role) {
  return role === "captain" ? "crew" : "captain";
}

export function chooseWaitingRoom(rooms, role) {
  const opposite = oppositeRole(role);
  return [...rooms.values()]
    .filter(room => !room[role] && Boolean(room[opposite]))
    .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
}

export function createRoomCode(randomValues = null) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = randomValues || crypto.getRandomValues(new Uint32Array(5));
  const suffix = [...values].slice(0, 5).map(value => alphabet[value % alphabet.length]).join("");
  return `SEA-${suffix}`;
}

export function publicRoomList(rooms, now = Date.now()) {
  return [...rooms.values()]
    .filter(room => Boolean(room.captain) !== Boolean(room.crew))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(room => ({
      id: room.id,
      waitingFor: room.captain ? "crew" : "captain",
      ageSeconds: Math.max(0, Math.floor((now - room.createdAt) / 1000)),
    }));
}
