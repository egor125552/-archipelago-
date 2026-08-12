"use strict";

export const FREE_STATE_STREAM_WINDOW = 8;
export const LIVE_DOCUMENT_CACHE_CONTROL = "no-store, max-age=0, must-revalidate";
// During emergency stabilization browser game code must never be pinned for a
// year. Several historical fixes reused an existing ?v= URL; immutable caching
// can therefore resurrect an already-fixed client after a deployment.
export const VERSIONED_ASSET_CACHE_CONTROL = LIVE_DOCUMENT_CACHE_CONTROL;

function asUrl(value) {
  if (value instanceof URL) return value;
  return new URL(String(value || "/"), "https://archipelago.invalid");
}

export function freeRoamDocument(pathname) {
  return pathname === "/free-roam" || pathname === "/free-roam/" || pathname === "/free-roam.html";
}

export function versionedStaticAsset(value) {
  const url = asUrl(value);
  const pathname = url.pathname;
  return url.searchParams.has("v") && (
    pathname.startsWith("/src/")
    || pathname.endsWith(".js")
    || pathname.endsWith(".css")
  );
}

export function browserCacheControl(value) {
  const url = asUrl(value);
  const pathname = url.pathname;
  if (freeRoamDocument(pathname) || pathname === "/" || pathname === "/index.html") {
    return LIVE_DOCUMENT_CACHE_CONTROL;
  }
  if (versionedStaticAsset(url)) return VERSIONED_ASSET_CACHE_CONTROL;
  if (pathname.startsWith("/src/") || pathname.endsWith(".css")) {
    return LIVE_DOCUMENT_CACHE_CONTROL;
  }
  return null;
}

export function streamWindowCount(client) {
  return Math.max(0, Number(client?.freeUnackedStreamStates) || 0);
}

export function streamWindowCanSend(client) {
  return streamWindowCount(client) < FREE_STATE_STREAM_WINDOW;
}

export function resetStreamWindowAfterAck(client) {
  if (!client || client.freeStateInFlight) return false;
  if (!streamWindowCount(client) && !client.freeStreamBaseWorld) return false;
  client.freeUnackedStreamStates = 0;
  client.freeStreamBaseWorld = client.freeAckedWorld || null;
  return true;
}
