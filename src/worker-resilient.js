import persistentWorker, {Lobby as PersistentLobby} from "./worker-persistent.js";

export const FREE_STATE_ACK_TIMEOUT_MS = 1800;
export const ARCHIPELAGO_BUILD_ID = "2026-08-07-armored-spatial-audio-6";

const FREE_ROAM_HTML_REPLACEMENTS = Object.freeze([
  ["free-roam-v4.js?v=62", "free-roam-v4.js?v=66"],
  ["/src/free-roam-core-v8.js?v=4", "/src/free-roam-core-v8.js?v=5"],
  ["/src/free-roam-client-prediction.js?v=43", "/src/free-roam-client-prediction.js?v=44"],
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

function freeRoamDocument(pathname) {
  return pathname === "/free-roam" || pathname === "/free-roam/" || pathname === "/free-roam.html";
}

function injectFreeRoamBuild(html) {
  let result = String(html || "");
  for (const [from, to] of FREE_ROAM_HTML_REPLACEMENTS) result = result.replaceAll(from, to);
  const extraMappings = [
    '        "/src/free-roam-audio-v5.js?v=45": "/src/free-roam-audio-v5.js?v=46",',
    '        "/src/free-roam-audio-v4.js?v=38": "/src/free-roam-audio-v4.js?v=41",',
    '        "/src/free-roam-audio-v4.js?v=39": "/src/free-roam-audio-v4.js?v=41",',
    '        "/src/free-roam-audio-v3.js?v=38": "/src/free-roam-audio-v3.js?v=39",',
    '        "/src/free-roam-audio-v2.js?v=38": "/src/free-roam-audio-v2.js?v=40",',
    '        "/src/free-roam-audio-v2.js?v=39": "/src/free-roam-audio-v2.js?v=40",',
    '        "/src/free-roam-dual-turret-weapons.js?v=4": "/src/free-roam-dual-turret-weapons.js?v=6",',
    '        "/src/free-roam-dual-turret-weapons.js?v=5": "/src/free-roam-dual-turret-weapons.js?v=6",',
    '        "/src/free-roam-shop.js?v=4": "/src/free-roam-shop.js?v=5",',
    '        "/src/free-roam-shop.js?v=3": "/src/free-roam-shop.js?v=5",',
  ].join("\n");
  if (!result.includes("free-roam-audio-v5.js?v=46")) {
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

function noStoreAsset(pathname) {
  return freeRoamDocument(pathname)
    || pathname === "/"
    || pathname === "/index.html"
    || pathname.startsWith("/src/")
    || pathname.endsWith(".css");
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
  if (url.pathname.startsWith("/api/") || !noStoreAsset(url.pathname)) return response;

  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, max-age=0, must-revalidate");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.set("x-archipelago-build", ARCHIPELAGO_BUILD_ID);

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

export default {fetch: fetchWithBuild};
