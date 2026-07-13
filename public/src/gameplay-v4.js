"use strict";

const byId = id => document.getElementById(id);
const controlMap = Object.freeze({
  leftButton: "left",
  rightButton: "right",
  throttleButton: "forward",
  reverseButton: "reverse",
  pumpButton: "pump",
  rescueButton: "rescue",
});
let timedMode = false;
let lastCourseAnnouncement = 0;

function gameApi() { return window.__echoArchipelago; }
function state() { return gameApi()?.getState?.() || null; }
function readerMode() { return document.body.dataset.accessibility === "reader"; }

function say(text) {
  if (!text) return;
  const live = byId("liveStatus");
  if (live) {
    live.textContent = "";
    requestAnimationFrame(() => { live.textContent = text; });
  }
  if (readerMode() || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ru-RU";
  utterance.rate = 1.18;
  window.speechSynthesis.speak(utterance);
}

function setPace(timed) {
  timedMode = Boolean(timed);
  window.__echoNextTimed = timedMode;
  byId("paceFree")?.setAttribute("aria-pressed", String(!timedMode));
  byId("paceTimed")?.setAttribute("aria-pressed", String(timedMode));
  const hint = byId("paceHint");
  if (hint) hint.textContent = timedMode
    ? "Штормовой режим: на спасение и возвращение даётся четыре минуты."
    : "Свободный режим: таймер не завершает операцию. Опасности, топливо и повреждения остаются.";
}

function applyPaceToNextSession() {
  let attempts = 0;
  const timer = setInterval(() => {
    const current = state();
    attempts += 1;
    if (current) {
      current.timed = timedMode;
      clearInterval(timer);
      if (!timedMode) {
        const time = byId("time");
        if (time) time.textContent = "Без лимита";
      }
    } else if (attempts > 40) clearInterval(timer);
  }, 25);
}

function courseText() {
  const current = state();
  if (!current) return "";
  const heading = Math.round((current.boat.heading + 360) % 360);
  return `Курс ${heading} градусов.`;
}

function bindReliableControl(button, control) {
  if (!button) return;
  let active = false;
  let pointerId = null;

  const stop = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const release = event => {
    if (!active) return;
    if (event) stop(event);
    active = false;
    gameApi()?.control?.(control, false);
    button.classList.remove("held");
    if ((control === "left" || control === "right") && performance.now() - lastCourseAnnouncement > 300) {
      lastCourseAnnouncement = performance.now();
      say(courseText());
    }
    try { if (pointerId != null) button.releasePointerCapture?.(pointerId); } catch (_) {}
    pointerId = null;
  };

  button.addEventListener("pointerdown", event => {
    if (readerMode()) return;
    stop(event);
    pointerId = event.pointerId;
    try { button.setPointerCapture?.(pointerId); } catch (_) {}
    active = Boolean(gameApi()?.control?.(control, true));
    if (active) button.classList.add("held");
  }, true);
  button.addEventListener("pointerup", release, true);
  button.addEventListener("pointercancel", release, true);

  button.addEventListener("click", event => {
    if (!readerMode()) return;
    stop(event);
    if (!gameApi()?.control?.(control, true)) return;
    button.classList.add("held");
    const duration = control === "left" || control === "right" ? 900 : control === "forward" ? 700 : 620;
    setTimeout(() => {
      gameApi()?.control?.(control, false);
      button.classList.remove("held");
      if (control === "left" || control === "right") say(courseText());
    }, duration);
  }, true);
}

function statusWithoutTimer() {
  const current = gameApi()?.getView?.();
  if (!current) return "Операция ещё не запущена.";
  return `${current.message} Скорость ${current.boat.speed.toFixed(1)} узла. Курс ${Math.round((current.boat.heading + 360) % 360)} градусов. Корпус ${Math.round(current.boat.hull)} процентов. Вода ${Math.round(current.boat.water)} процентов. Топливо ${Math.round(current.boat.fuel)} процентов. Спасено ${current.rescued} из двух. Режим без ограничения времени.`;
}

byId("paceFree")?.addEventListener("click", () => setPace(false));
byId("paceTimed")?.addEventListener("click", () => setPace(true));
for (const id of ["soloButton", "hostPeer", "joinPeer", "hostLocal", "joinLocal"]) {
  byId(id)?.addEventListener("click", applyPaceToNextSession, true);
}
for (const [id, control] of Object.entries(controlMap)) bindReliableControl(byId(id), control);

byId("statusButton")?.addEventListener("click", event => {
  const current = state();
  if (!current || current.timed) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  say(statusWithoutTimer());
}, true);

setInterval(() => {
  const current = state();
  if (!current || current.timed) return;
  const time = byId("time");
  if (time && time.textContent !== "Без лимита") time.textContent = "Без лимита";
}, 200);

setPace(false);
