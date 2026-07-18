"use strict";

const LOOKALIKE_MAP = Object.freeze({
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H",
  "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
  "І": "I", "Ї": "I", "Ј": "J", "З": "3", "Б": "6"
});

export function normalizeRoomCode(value, maxLength = 12) {
  const upper = String(value || "").trim().toUpperCase().replace(/Ё/g, "Е");
  let result = "";
  for (const char of upper) {
    const mapped = LOOKALIKE_MAP[char] || char;
    if (/^[A-Z0-9-]$/.test(mapped)) result += mapped;
    if (result.length >= maxLength) break;
  }
  return result;
}

export function workerSocketUrl(locationLike, role) {
  const source = locationLike || globalThis.location;
  if (!source?.host) throw new Error("Адрес сервера комнат не определён");
  const protocol = source.protocol === "https:" ? "wss:" : "ws:";
  const safeRole = role === "captain" ? "captain" : "crew";
  return `${protocol}//${source.host}/api/connect?role=${safeRole}`;
}

function dispatchRoomEvent(name, detail) {
  if (typeof globalThis.dispatchEvent !== "function" || typeof globalThis.CustomEvent !== "function") return;
  globalThis.dispatchEvent(new CustomEvent(name, {detail}));
}

export class LocalRoomTransport {
  constructor(room, role) {
    this.room = normalizeRoomCode(room) || "DEMO";
    this.role = role;
    this.channel = null;
    this.handlers = new Set();
  }
  connect() {
    if (!("BroadcastChannel" in globalThis)) throw new Error("Локальные комнаты не поддерживаются этим браузером");
    this.channel = new BroadcastChannel(`echo-archipelago:${this.room}`);
    this.channel.onmessage = event => this.handlers.forEach(handler => handler(event.data));
    this.send({type: "hello", role: this.role});
  }
  onMessage(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  send(payload) { this.channel?.postMessage({...payload, senderRole: this.role, sentAt: Date.now()}); }
  close() { this.channel?.close(); this.channel = null; }
}

export class PeerRoomTransport {
  constructor(_room, role) {
    this.room = "";
    this.role = role === "captain" ? "captain" : "crew";
    this.socket = null;
    this.handlers = new Set();
    this.closedByUser = false;
  }

  emit(message) {
    this.handlers.forEach(handler => handler(message));
    if (message?.type === "peer-connected") {
      setTimeout(() => dispatchRoomEvent("echo-room-peer-connected", {room: this.room, role: this.role}), 0);
    }
  }

  connect() {
    if (!("WebSocket" in globalThis)) throw new Error("Этот браузер не поддерживает интернет-комнаты");
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error("Сервер комнат не ответил за 12 секунд"));
      }, 12000);

      const socket = new WebSocket(workerSocketUrl(globalThis.location, this.role));
      this.socket = socket;

      socket.addEventListener("message", event => {
        let message;
        try { message = JSON.parse(String(event.data)); }
        catch (_) { return; }

        if (message?.type === "lobby-ready") {
          this.room = normalizeRoomCode(message.room) || String(message.room || "");
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            resolve();
          }
          setTimeout(() => dispatchRoomEvent("echo-room-ready", {
            room: this.room,
            role: this.role,
            matched: Boolean(message.matched),
            waitingFor: message.waitingFor || null,
          }), 0);
          return;
        }

        this.emit(message);
      });

      socket.addEventListener("error", () => {
        const error = new Error("Cloudflare Worker не открыл соединение с комнатой");
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(error);
        } else {
          this.emit({type: "network-error", message: error.message});
        }
      });

      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error("Сервер комнат закрыл соединение до входа"));
        } else if (!this.closedByUser) {
          this.emit({type: "network-closed"});
        }
      });
    });
  }

  onMessage(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }

  send(payload) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({...payload, senderRole: this.role, sentAt: Date.now()}));
  }

  close() {
    this.closedByUser = true;
    try { this.socket?.close(1000, "client close"); } catch (_) {}
    this.socket = null;
  }
}
