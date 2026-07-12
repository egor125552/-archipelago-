"use strict";

export class LocalRoomTransport {
  constructor(room, role) {
    this.room = String(room || "DEMO").toUpperCase();
    this.role = role;
    this.channel = null;
    this.handlers = new Set();
  }
  connect() {
    if (!("BroadcastChannel" in globalThis)) throw new Error("BroadcastChannel unavailable");
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
    this.room = String(room || "DEMO").toUpperCase();
    this.role = role;
    this.peer = null;
    this.connection = null;
    this.handlers = new Set();
  }
  async connect() {
    if (!globalThis.Peer) throw new Error("PeerJS unavailable");
    if (this.role === "captain") {
      this.peer = new globalThis.Peer(`echo-archipelago-${this.room.toLowerCase()}`);
      await new Promise((resolve, reject) => {
        this.peer.on("open", resolve);
        this.peer.on("error", reject);
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Crew connection timeout")), 90000);
        this.peer.on("connection", connection => {
          clearTimeout(timeout);
          this.connection = connection;
          connection.on("data", data => this.handlers.forEach(handler => handler(data)));
          connection.on("open", resolve);
        });
      });
    } else {
      this.peer = new globalThis.Peer();
      await new Promise((resolve, reject) => {
        this.peer.on("open", resolve);
        this.peer.on("error", reject);
      });
      this.connection = this.peer.connect(`echo-archipelago-${this.room.toLowerCase()}`, {reliable: true});
      await new Promise((resolve, reject) => {
        this.connection.on("open", resolve);
        this.connection.on("error", reject);
      });
      this.connection.on("data", data => this.handlers.forEach(handler => handler(data)));
    }
  }
  onMessage(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  send(payload) { if (this.connection?.open) this.connection.send({...payload, senderRole: this.role, sentAt: Date.now()}); }
  close() { this.connection?.close(); this.peer?.destroy(); }
}
