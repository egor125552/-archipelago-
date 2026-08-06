import persistentWorker, {Lobby as PersistentLobby} from "./worker-persistent.js";

export const FREE_STATE_ACK_TIMEOUT_MS = 1800;

function stalledFreeState(client, now = Date.now()) {
  return Boolean(
    client?.mode === "free"
    && client.freeStateInFlight
    && Number(client.freeStateSentAt) > 0
    && now - Number(client.freeStateSentAt) >= FREE_STATE_ACK_TIMEOUT_MS
  );
}

function openSocket(socket) {
  return Boolean(socket && socket.readyState === 1 && typeof socket.send === "function");
}

export class Lobby extends PersistentLobby {
  resendStalledFreeState(socket, now = Date.now()) {
    const client = this.clients.get(socket);
    if (!stalledFreeState(client, now)) return false;
    const inFlight = client.freeInFlightState;
    if (!inFlight || !openSocket(socket)) {
      // Compatibility fallback for a connection created by an older worker
      // version that did not remember the exact in-flight payload.
      client.freeStateInFlight = 0;
      client.freeInFlightWorld = null;
      client.freeAckedWorld = null;
      client.freeStateSentAt = 0;
      client.freeInFlightState = null;
      client.freeStateResends = (Number(client.freeStateResends) || 0) + 1;
      return this.flushFreeState(socket);
    }

    const roleIndex = client.role === "captain" ? 0 : 1;
    try {
      socket.send(JSON.stringify({
        type: "free-state",
        sequence: inFlight.sequence,
        serverAt: now,
        ackInput: inFlight.ackInput?.[roleIndex] || 0,
        full: true,
        world: inFlight.world,
        delta: null,
        events: inFlight.events || [],
      }));
    } catch (_) {
      return false;
    }
    // The sequence deliberately stays unchanged. A client that already
    // applied this packet will ignore its events and only repeat the ACK.
    client.freeStateSentAt = now;
    client.freeStateResends = (Number(client.freeStateResends) || 0) + 1;
    return true;
  }

  offerFreeState(socket, state) {
    const offered = super.offerFreeState(socket, state);
    return this.resendStalledFreeState(socket) || offered;
  }

  flushFreeState(socket) {
    const client = this.clients.get(socket);
    const pendingState = client?.freePending
      ? {
          ...client.freePending,
          events: Array.isArray(client.freePending.events)
            ? [...client.freePending.events]
            : [],
        }
      : null;
    const sent = super.flushFreeState(socket);
    const refreshed = this.clients.get(socket);
    if (sent && refreshed?.freeStateInFlight) {
      refreshed.freeStateSentAt = Date.now();
      refreshed.freeInFlightState = pendingState;
    } else if (refreshed && !refreshed.freeStateInFlight) {
      refreshed.freeStateSentAt = 0;
      refreshed.freeInFlightState = null;
    }
    return sent;
  }
}

export default persistentWorker;
