"use strict";

export const FREE_STATE_STREAM_WINDOW = 8;
export const VERSIONED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const LIVE_DOCUMENT_CACHE_CONTROL = "no-store, max-age=0, must-revalidate";

function asUrl(value) {
  if (value instanceof URL) return value;
  return new URL(String(value || "/"), "https://archipelago.invalid");
}

export function freeRoamDocument(pathname) {
  return pathname === "/free-roam" || pathname === "/free-roam/" || pathname === "/free-roam.html";
}

export function versionedStaticAsset(value) {
  const url = asUrl(value);
  if (!url.searchParams.has("v")) return false;
  return url.pathname.startsWith("/src/")
    || url.pathname.endsWith(".js")
    || url.pathname.endsWith(".css");
}

export function browserCacheControl(value) {
  const url = asUrl(value);
  const pathname = url.pathname;
  if (freeRoamDocument(pathname) || pathname === "/" || pathname === "/index.html") {
    return LIVE_DOCUMENT_CACHE_CONTROL;
  }
  if (versionedStaticAsset(url)) return VERSIONED_ASSET_CACHE_CONTROL;
  if (pathname.startsWith("/src/") || pathname.endsWith(".css")) return LIVE_DOCUMENT_CACHE_CONTROL;
  return null;
}

export function streamWindowCount(client) {
  return Math.max(0, Math.floor(Number(client?.freeUnackedStreamStates) || 0));
}

export function streamWindowCanSend(client, maximum = FREE_STATE_STREAM_WINDOW) {
  return streamWindowCount(client) < Math.max(1, Math.floor(Number(maximum) || FREE_STATE_STREAM_WINDOW));
}

export function resetStreamWindowAfterAck(client) {
  if (!client || client.freeStateInFlight) return false;
  if (!client.freeUnackedStreamStates && !client.freeStreamBaseWorld) return false;
  client.freeUnackedStreamStates = 0;
  client.freeStreamBaseWorld = client.freeAckedWorld || null;
  return true;
}
