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

export class Lobby extends PersistentLobby {
  expireStalledFreeState(socket, now = Date.now()) {
    const client = this.clients.get(socket);
    if (!stalledFreeState(client, now)) return [];
    const retryEvents = Array.isArray(client.freeInFlightEvents)
      ? client.freeInFlightEvents
      : [];
    // The previous ACK may have been lost after the client applied the state.
    // A delta would then have an uncertain base, so the retry is deliberately
    // a fresh full snapshot rather than another patch against stale state.
    client.freeStateInFlight = 0;
    client.freeInFlightWorld = null;
    client.freeAckedWorld = null;
    client.freeStateSentAt = 0;
    client.freeInFlightEvents = [];
    client.freeStateResends = (Number(client.freeStateResends) || 0) + 1;
    return retryEvents;
  }

  offerFreeState(socket, state) {
    const client = this.clients.get(socket);
    const retryEvents = this.expireStalledFreeState(socket);
    if (!retryEvents.length) return super.offerFreeState(socket, state);

    const queuedEvents = Array.isArray(client?.freePending?.events)
      ? client.freePending.events
      : [];
    // Preserve audible chronology: unacknowledged events first, then events
    // accumulated while waiting, and only then events from the newest tick.
    if (client) client.freePending = null;
    return super.offerFreeState(socket, {
      ...state,
      events: [...retryEvents, ...queuedEvents, ...(state?.events || [])],
    });
  }

  flushFreeState(socket) {
    const client = this.clients.get(socket);
    const pendingEvents = Array.isArray(client?.freePending?.events)
      ? [...client.freePending.events]
      : [];
    const sent = super.flushFreeState(socket);
    const refreshed = this.clients.get(socket);
    if (sent && refreshed?.freeStateInFlight) {
      refreshed.freeStateSentAt = Date.now();
      refreshed.freeInFlightEvents = pendingEvents;
    } else if (refreshed && !refreshed.freeStateInFlight) {
      refreshed.freeStateSentAt = 0;
      refreshed.freeInFlightEvents = [];
    }
    return sent;
  }
}

export default persistentWorker;
