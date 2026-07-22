"use strict";

const REPORT_KEY = "echo-free-roam-gesture-last-report-v1";
const MAX_LOG_ENTRIES = 220;
const activePointers = new Map();
const log = [];
const game = document.getElementById("game");
const controlModeButton = document.getElementById("controlModeButton");

function nowMs() {
  return Math.round(performance.now());
}

function targetLabel(target) {
  if (!(target instanceof Element)) return String(target?.nodeName || "unknown");
  return target.id || target.getAttribute("role") || target.tagName.toLowerCase();
}

function activeSnapshot() {
  return [...activePointers.values()].map(pointer => ({...pointer}));
}

function record(type, event = null, extra = {}) {
  const entry = {
    at: nowMs(),
    type,
    pointerId: event && "pointerId" in event ? Number(event.pointerId) : null,
    pointerType: event && "pointerType" in event ? String(event.pointerType || "") : null,
    isPrimary: event && "isPrimary" in event ? Boolean(event.isPrimary) : null,
    buttons: event && "buttons" in event ? Number(event.buttons) : null,
    target: event ? targetLabel(event.target) : null,
    gestureMode: document.body.classList.contains("gesture-mode"),
    visibility: document.visibilityState,
    active: activeSnapshot(),
    ...extra,
  };
  log.push(entry);
  if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  return entry;
}

function buildReport(reason, extra = {}) {
  return {
    version: 1,
    reason,
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform || "",
    maxTouchPoints: Number(navigator.maxTouchPoints) || 0,
    gestureMode: document.body.classList.contains("gesture-mode"),
    visibility: document.visibilityState,
    activePointers: activeSnapshot(),
    recentEvents: log.slice(),
    ...extra,
  };
}

function persistReport(reason, extra = {}) {
  const report = buildReport(reason, extra);
  try { localStorage.setItem(REPORT_KEY, JSON.stringify(report)); } catch (_) {}
  return report;
}

function createPointerCancel(pointer) {
  const init = {
    bubbles: true,
    cancelable: true,
    pointerId: pointer.pointerId,
    pointerType: pointer.pointerType || "touch",
    isPrimary: Boolean(pointer.isPrimary),
    clientX: Number(pointer.clientX) || 0,
    clientY: Number(pointer.clientY) || 0,
    buttons: 0,
  };
  try {
    return new PointerEvent("pointercancel", init);
  } catch (_) {
    const fallback = new Event("pointercancel", {bubbles: true, cancelable: true});
    for (const [key, value] of Object.entries(init)) {
      try { Object.defineProperty(fallback, key, {configurable: true, value}); } catch (_) {}
    }
    return fallback;
  }
}

function cancelTrackedPointer(pointer, reason) {
  if (!game || !pointer) return;
  record("synthetic-pointercancel", null, {reason, cancelledPointerId: pointer.pointerId});
  game.dispatchEvent(createPointerCancel(pointer));
}

function resetTrackedPointers(reason, {save = false, extra = {}} = {}) {
  const stale = activeSnapshot();
  if (save) persistReport(reason, {stalePointers: stale, ...extra});
  for (const pointer of stale) cancelTrackedPointer(pointer, reason);
  activePointers.clear();
  record("pointer-state-reset", null, {reason, cleared: stale.map(pointer => pointer.pointerId)});
}

function pointerData(event) {
  return {
    pointerId: Number(event.pointerId),
    pointerType: String(event.pointerType || "touch"),
    isPrimary: Boolean(event.isPrimary),
    clientX: Number(event.clientX) || 0,
    clientY: Number(event.clientY) || 0,
    lastAt: nowMs(),
  };
}

document.addEventListener("pointerdown", event => {
  if (event.pointerType !== "touch") return;

  // The browser may mark a touch as primary only when it believes no older
  // touch remains. If the game still has tracked pointers at that moment, the
  // previous gesture is stale and can safely be cancelled before this new one.
  if (event.isPrimary && activePointers.size && !activePointers.has(event.pointerId)) {
    const staleIds = [...activePointers.keys()];
    persistReport("primary-pointer-mismatch", {
      incomingPointerId: Number(event.pointerId),
      stalePointerIds: staleIds,
    });
    resetTrackedPointers("primary-pointer-mismatch");
  }

  activePointers.set(event.pointerId, pointerData(event));
  record("pointerdown", event);
}, true);

document.addEventListener("pointermove", event => {
  if (event.pointerType !== "touch" || !activePointers.has(event.pointerId)) return;
  activePointers.set(event.pointerId, pointerData(event));
  record("pointermove", event);
}, true);

for (const type of ["pointerup", "pointercancel"]) {
  document.addEventListener(type, event => {
    if (event.pointerType !== "touch") return;
    record(type, event);
    activePointers.delete(event.pointerId);
  }, true);
}

document.addEventListener("lostpointercapture", event => {
  if (event.pointerType !== "touch") return;
  record("lostpointercapture", event);
  const pointer = activePointers.get(event.pointerId);
  if (!pointer) return;
  persistReport("lost-pointer-capture", {lostPointerId: Number(event.pointerId)});
  cancelTrackedPointer(pointer, "lost-pointer-capture");
  activePointers.delete(event.pointerId);
}, true);

controlModeButton?.addEventListener("click", () => {
  // This is the user's known recovery action. Preserve the exact event trail
  // before clearing pointers so a rare freeze becomes inspectable afterward.
  persistReport("control-mode-recovery", {
    hadTrackedPointers: activePointers.size > 0,
  });
  resetTrackedPointers("control-mode-recovery");
}, true);

window.addEventListener("blur", () => {
  if (activePointers.size) resetTrackedPointers("window-blur", {save: true});
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && activePointers.size) {
    resetTrackedPointers("document-hidden", {save: true});
  }
});

window.addEventListener("pagehide", () => {
  if (activePointers.size) resetTrackedPointers("pagehide", {save: true});
});

function readStoredReport() {
  try {
    const stored = localStorage.getItem(REPORT_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch (_) {
    return null;
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  const copied = document.execCommand?.("copy") ?? false;
  area.remove();
  return Boolean(copied);
}

function reportMessage(text) {
  const message = document.getElementById("message");
  const live = document.getElementById("live");
  if (message) message.textContent = text;
  if (live) {
    live.setAttribute("aria-live", "assertive");
    live.textContent = "";
    requestAnimationFrame(() => { live.textContent = text; });
  }
}

const headerActions = document.querySelector(".header-actions");
if (headerActions && !document.getElementById("gestureReportButton")) {
  const button = document.createElement("button");
  button.id = "gestureReportButton";
  button.className = "small";
  button.textContent = "Скопировать сбой жестов";
  button.addEventListener("click", async () => {
    const report = readStoredReport() || buildReport("manual-copy-without-saved-failure");
    try {
      const copied = await copyText(JSON.stringify(report, null, 2));
      reportMessage(copied
        ? "Отчёт о жестах скопирован. Отправь его в чат после сбоя."
        : "Не удалось скопировать отчёт. Попробуй ещё раз.");
    } catch (_) {
      reportMessage("Не удалось скопировать отчёт о жестах.");
    }
  });
  const leaveButton = document.getElementById("leaveButton");
  headerActions.insertBefore(button, leaveButton || null);
}

record("watchdog-ready");

globalThis.__freeRoamGestureDiagnostics = {
  activePointers: () => activeSnapshot(),
  currentLog: () => log.slice(),
  lastReport: readStoredReport,
  save: reason => persistReport(reason || "manual-save"),
  reset: () => resetTrackedPointers("manual-api-reset", {save: true}),
};
