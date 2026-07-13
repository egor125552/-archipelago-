"use strict";

const LOOKALIKE_MAP = Object.freeze({
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H",
  "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
  "І": "I", "Ї": "I", "Ј": "J", "З": "3", "Б": "6"
});

export function normalizeRoomCode(value, maxLength = 6) {
  const upper = String(value || "").trim().toUpperCase().replace(/Ё/g, "Е");
  let result = "";
  for (const char of upper) {
    const mapped = LOOKALIKE_MAP[char] || char;
    if (/^[A-Z0-9]$/.test(mapped)) result += mapped;
    if (result.length >= maxLength) break;
  }
  return result;
}

function peerIdFor(room) {
  const code = normalizeRoomCode(room);
  if (code.length < 4) throw new Error("Код комнаты должен содержать от 4 до 6 латинских букв или цифр");
  return `echo-archipelago-${code.toLowerCase()}`;
}

function waitForEvent(target, eventName, errorName = "error", timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Время подключения истекло"));
    }, timeoutMs);
    const onSuccess = value => { cleanup(); resolve(value); };
    const onError = error => { cleanup(); reject(error instanceof Error ? error : new Error(String(error?.message || error || "Ошибка подключения"))); };
    const cleanup = () => {
      clearTimeout(timeout);
      target.off?.(eventName, onSuccess);
      target.off?.(errorName, onError);
    };
    target.on(eventName, onSuccess);
    target.on(errorName, onError);
  });
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
  constructor(room, role) {
    this.room = normalizeRoomCode(room);
    this.role = role;
    this.peer = null;
    this.connection = null;
    this.handlers = new Set();
  }

  bindConnection(connection) {
    this.connection = connection;
    connection.on("data", data => this.handlers.forEach(handler => handler(data)));
    connection.on("error", error => this.handlers.forEach(handler => handler({type: "network-error", message: error?.message || "Ошибка соединения"})));
    connection.on("close", () => this.handlers.forEach(handler => handler({type: "network-closed"})));
  }

  async connect() {
    if (!globalThis.Peer) throw new Error("Интернет-модуль не загрузился. Проверь соединение и обнови страницу");
    const targetId = peerIdFor(this.room);

    if (this.role === "captain") {
      this.peer = new globalThis.Peer(targetId);
      this.peer.on("connection", connection => {
        this.bindConnection(connection);
        connection.on("open", () => this.handlers.forEach(handler => handler({type: "peer-connected"})));
      });
      await waitForEvent(this.peer, "open", "error", 15000);
      return;
    }

    this.peer = new globalThis.Peer();
    await waitForEvent(this.peer, "open", "error", 15000);
    const connection = this.peer.connect(targetId, {reliable: true});
    this.bindConnection(connection);
    await waitForEvent(connection, "open", "error", 15000);
  }

  onMessage(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  send(payload) { if (this.connection?.open) this.connection.send({...payload, senderRole: this.role, sentAt: Date.now()}); }
  close() { this.connection?.close(); this.peer?.destroy(); this.connection = null; this.peer = null; }
}
