import persistentWorker, {Lobby as PersistentLobby} from "./worker-persistent.js";
import {FREE_STATE_ACK_TIMEOUT_MS} from "./worker-resilient-config.js";
import {freePlayerIndex} from "./free-roam-server.js";
import {diffReplicatedWorld} from "../public/src/free-roam-replication.js";
import {
  browserCacheControl,
  freeRoamDocument,
  resetStreamWindowAfterAck,
  streamWindowCanSend,
  streamWindowCount,
} from "./worker-delivery-policy.js";

const ARCHIPELAGO_BUILD_ID = "2026-08-12-v1.7.5-medium-engine-remote-fix";

const FREE_ROAM_HTML_REPLACEMENTS = Object.freeze([
  ["free-roam-v4.js?v=62", "free-roam-v4.js?v=66"],
  ["free-roam-dual-turret-client.js?v=7", "free-roam-dual-turret-client.js?v=11"],
  ["free-roam-dual-turret-client.js?v=9", "free-roam-dual-turret-client.js?v=11"],
  ["free-roam-dual-turret-client.js?v=10", "free-roam-dual-turret-client.js?v=11"],
  ["/src/free-roam-core-v8.js?v=4", "/src/free-roam-core-v8.js?v=5"],
  ["/src/free-roam-client-prediction.js?v=43", "/src/free-roam-client-prediction.js?v=44"],
  ["/src/vessel/vessel-plugin-manifest.js?v=7", "/src/vessel/vessel-plugin-manifest.js?v=9"],
  ["/src/vessel/vessel-plugin-manifest.js?v=8", "/src/vessel/vessel-plugin-manifest.js?v=9"],
  ["/src/vessel/systems/vessel-deck-input-bridge-system.js?v=3", "/src/vessel/systems/vessel-deck-input-bridge-system.js?v=4"],
  ["/src/free-roam-shop.js?v=5", "/src/free-roam-shop.js?v=6"],
  ["/src/free-roam-dual-turret-projectiles.js?v=4", "/src/free-roam-dual-turret-projectiles.js?v=5"],
  ["/src/free-roam-dual-turret-audio.js?v=4", "/src/free-roam-dual-turret-audio.js?v=7"],
]);

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

function sendSocketJson(socket, payload) {
  if (!openSocket(socket)) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function injectFreeRoamBuild(html) {
  let result = String(html || "");
  for (const [from, to] of FREE_ROAM_HTML_REPLACEMENTS) result = result.replaceAll(from, to);
  const extraMappings = [
    '        "/src/free-roam-audio-v5.js?v=45": "/src/free-roam-audio-v5.js?v=46",',
    '        "/src/free-roam-audio-v4.js?v=38": "/src/free-roam-audio-v4.js?v=43",',
    '        "/src/free-roam-audio-v4.js?v=39": "/src/free-roam-audio-v4.js?v=43",',
    '        "/src/free-roam-audio-v4.js?v=41": "/src/free-roam-audio-v4.js?v=43",',
    '        "/src/free-roam-audio-v4.js?v=42": "/src/free-roam-audio-v4.js?v=43",',
    '        "/src/free-roam-audio-v3.js?v=38": "/src/free-roam-audio-v3.js?v=40",',
    '        "/src/free-roam-audio-v3.js?v=39": "/src/free-roam-audio-v3.js?v=40",',
    '        "/src/free-roam-audio-v2.js?v=38": "/src/free-roam-audio-v2.js?v=41",',
    '        "/src/free-roam-audio-v2.js?v=39": "/src/free-roam-audio-v2.js?v=41",',
    '        "/src/free-roam-audio-v2.js?v=40": "/src/free-roam-audio-v2.js?v=41",',
    '        "/src/free-roam-targeting.js?v=35": "/src/free-roam-targeting.js?v=40",',
    '        "/src/free-roam-targeting.js?v=36": "/src/free-roam-targeting.js?v=40",',
    '        "/src/free-roam-targeting.js?v=39": "/src/free-roam-targeting.js?v=40",',
    '        "/src/free-roam-dual-turret-weapons.js?v=4": "/src/free-roam-dual-turret-weapons.js?v=6",',
    '        "/src/free-roam-dual-turret-weapons.js?v=5": "/src/free-roam-dual-turret-weapons.js?v=6",',
    '        "/src/free-roam-shop.js?v=3": "/src/free-roam-shop.js?v=6",',
    '        "/src/free-roam-shop.js?v=4": "/src/free-roam-shop.js?v=6",',
    '        "/src/free-roam-shop.js?v=5": "/src/free-roam-shop.js?v=6",',
    '        "/src/vessel/systems/vessel-deck-input-bridge-system.js?v=2": "/src/vessel/systems/vessel-deck-input-bridge-system.js?v=4",',
    '        "/src/vessel/systems/vessel-deck-input-bridge-system.js?v=3": "/src/vessel/systems/vessel-deck-input-bridge-system.js?v=4",',
  ].join("\n");
  if (!result.includes("free-roam-audio-v4.js?v=43")) {
    result = result.replace(/"imports"\s*:\s*\{/, match => `${match}\n${extraMappings}`);
  }
  if (!result.includes("archipelago-build")) {
    result = result.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8">\n  <meta name="archipelago-build" content="${ARCHIPELAGO_BUILD_ID}">`,
    );
  }
  return result;
}

async function fetchWithBuild(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/api/build") {
    return new Response(JSON.stringify({build: ARCHIPELAGO_BUILD_ID}), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "x-archipelago-build": ARCHIPELAGO_BUILD_ID,
      },
    });
  }

  const response = await persistentWorker.fetch(request, env, ctx);
  if (url.pathname.startsWith("/api/")) return response;

  const cacheControl = browserCacheControl(url);
  if (!cacheControl) return response;

  const headers = new Headers(response.headers);
  headers.set("cache-control", cacheControl);
  headers.set("x-archipelago-build", ARCHIPELAGO_BUILD_ID);
  if (cacheControl.startsWith("public")) {
    headers.delete("pragma");
    headers.delete("expires");
  } else {
    headers.set("pragma", "no-cache");
    headers.set("expires", "0");
  }

  if (freeRoamDocument(url.pathname) && response.ok) {
    const html = injectFreeRoamBuild(await response.text());
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class Lobby extends PersistentLobby {
  resendStalledFreeState(socket, now = Date.now()) {
    const client = this.clients.get(socket);
    if (!stalledFreeState(client, now)) return false;
    const inFlight = client.freeInFlightState;
    if (!inFlight || !openSocket(socket)) {
      client.freeStateInFlight = 0;
      client.freeInFlightWorld = null;
      client.freeAckedWorld = null;
      client.freeStateSentAt = 0;
      client.freeInFlightState = null;
      client.freeStateResends = (Number(client.freeStateResends) || 0) + 1;
      return this.flushFreeState(socket);
    }

    const roleIndex = client.role === "captain" ? 0 : 1;
    if (!sendSocketJson(socket, {
      type: "free-state",
      sequence: inFlight.sequence,
      serverAt: now,
      ackInput: inFlight.ackInput?.[roleIndex] || 0,
      full: true,
      world: inFlight.world,
      delta: null,
      events: inFlight.events || [],
    })) return false;

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
    if (!client || client.mode !== "free") return false;

    resetStreamWindowAfterAck(client);
    if (!client.freePending || !streamWindowCanSend(client)) return false;

    const pending = client.freePending;
    const pendingState = {
      ...pending,
      events: Array.isArray(pending.events) ? [...pending.events] : [],
    };
    const playerIndex = freePlayerIndex(client.role);
    const baseWorld = client.freeStreamBaseWorld || client.freeAckedWorld || null;
    const full = !baseWorld;
    const payload = {
      type: "free-state",
      sequence: pending.sequence,
      serverAt: pending.serverAt,
      ackInput: pending.ackInput?.[playerIndex] || 0,
      full,
      events: pending.events || [],
    };
    if (full) payload.world = pending.world;
    else payload.delta = diffReplicatedWorld(baseWorld, pending.world);
    if (!sendSocketJson(socket, payload)) return false;

    client.freePending = null;
    client.freeUnackedStreamStates = streamWindowCount(client) + 1;
    client.freeStreamBaseWorld = pending.world;
    client.freeStateInFlight = pending.sequence;
    client.freeInFlightWorld = pending.world;
    client.freeStateSentAt = Date.now();
    client.freeInFlightState = pendingState;
    return true;
  }
}

export default {fetch: fetchWithBuild};
