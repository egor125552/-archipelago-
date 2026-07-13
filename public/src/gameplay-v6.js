"use strict";

const byId = id => document.getElementById(id);
const pulseControls = new Set(["left", "right", "forward", "reverse"]);
const toggleControls = new Set(["pump", "rescue", "hullRepair"]);
const controlMap = Object.freeze({
  leftButton: "left",
  rightButton: "right",
  throttleButton: "forward",
  reverseButton: "reverse",
  pumpButton: "pump",
  rescueButton: "rescue",
  repairHullButton: "hullRepair",
});
const toggled = new Map();
let timedMode = false;
let lastCourseAnnouncement = 0;
let lastTouchToggleAt = 0;

function gameApi() { return window.__echoArchipelago; }
function state() { return gameApi()?.getState?.() || null; }
function view() { return gameApi()?.getView?.() || null; }
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

function stopEvent(event) {
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
}

function setHeld(button, active) {
  button.classList.toggle("held", active);
  button.setAttribute("aria-pressed", String(active));
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
      if (!timedMode && byId("time")) byId("time").textContent = "Без лимита";
    } else if (attempts > 50) clearInterval(timer);
  }, 25);
}

function courseText() {
  const current = state();
  if (!current) return "";
  return `Курс ${Math.round((current.boat.heading + 360) % 360)} градусов.`;
}

function toggleText(control, active) {
  if (control === "rescue") return active
    ? "Трос подан. Держи лодку медленнее четырёх узлов. Нажми ещё раз, чтобы убрать трос."
    : "Трос убран.";
  if (control === "pump") return active ? "Насос включён. Нажми ещё раз, чтобы выключить." : "Насос выключен.";
  return active ? "Ремонт корпуса начат. Лодка должна быть почти неподвижна." : "Ремонт корпуса остановлен.";
}

function toggleControl(button, control) {
  const current = state();
  if (!current) return;
  if (control === "hullRepair" && current.mode === "coop" && document.body.dataset.role === "captain") {
    say("Заделкой пробоины занимается системный оператор.");
    return;
  }
  const next = !Boolean(current.controls?.[control]);
  if (!gameApi()?.control?.(control, next)) return;
  toggled.set(control, next);
  setHeld(button, next);
  say(toggleText(control, next));
}

function situationHint() {
  const current = state();
  const currentView = view();
  if (!current || !currentView) return "Операция ещё не запущена.";
  if (current.phase !== "playing") return current.message || "Операция завершена.";

  const speed = Math.abs(current.boat.speed);
  const leak = Number(current.boat.leak) || 0;
  const water = Number(current.boat.water) || 0;
  const hull = Number(current.boat.hull) || 0;
  const patches = Number(current.boat.repairPatches) || 0;

  if ((leak > 0.2 || hull < 70) && patches > 0) {
    if (speed > 2.2) return `Корпус повреждён. Снизь скорость с ${speed.toFixed(1)} примерно до двух узлов, затем нажми Заделать пробоину.`;
    return "Лодка почти остановлена. Нажми Заделать пробоину. После установки пластины включи насос, чтобы убрать воду.";
  }
  if (water > 30) return `В лодке ${Math.round(water)} процентов воды. Включи насос повторным нажатием и выключи, когда уровень снизится.`;
  if (current.rescued < 2) {
    const targetDistance = currentView.navigation?.targetDistance ?? currentView.nearestSurvivorDistance;
    const angle = currentView.navigation?.targetRelativeAngle;
    if (targetDistance == null) return "Нажми сонар, чтобы найти следующую цель.";
    if (targetDistance > currentView.rescueRadius + 1) {
      const direction = angle == null || Math.abs(angle) < 10 ? "прямо" : angle < 0 ? "слева" : "справа";
      return `Ближайшая цель ${direction}, примерно ${Math.round(targetDistance)} метров. Нажми сонар для точного курса.`;
    }
    if (speed > currentView.rescueSpeedLimit) return `Человек рядом, но скорость ${speed.toFixed(1)} узла. Снизь её ниже ${currentView.rescueSpeedLimit.toFixed(1)}, затем один раз нажми трос.`;
    const percent = Math.round((currentView.rescueProgress || 0) * 100);
    return percent > 0
      ? `Трос натянут на ${percent} процентов. Не нажимай повторно и держи лодку почти неподвижно.`
      : "Человек рядом и скорость подходит. Один раз нажми Подать спасательный трос. Повторное нажатие отменяет спасение.";
  }
  return "Оба человека на борту. Нажми сонар: он укажет гавань. Входи в неё на скорости не выше пяти узлов.";
}

function bindReliableControl(button, control) {
  if (!button) return;
  let active = false;
  let pointerId = null;

  const release = event => {
    if (!active) return;
    if (event) stopEvent(event);
    active = false;
    gameApi()?.control?.(control, false);
    setHeld(button, false);
    if ((control === "left" || control === "right") && performance.now() - lastCourseAnnouncement > 250) {
      lastCourseAnnouncement = performance.now();
      say(courseText());
    }
    try { if (pointerId != null) button.releasePointerCapture?.(pointerId); } catch (_) {}
    pointerId = null;
  };

  button.addEventListener("pointerdown", event => {
    if (readerMode()) return;
    stopEvent(event);

    if (toggleControls.has(control)) {
      lastTouchToggleAt = performance.now();
      toggleControl(button, control);
      return;
    }

    pointerId = event.pointerId;
    try { button.setPointerCapture?.(pointerId); } catch (_) {}
    active = Boolean(gameApi()?.control?.(control, true));
    if (active) setHeld(button, true);
  }, true);
  button.addEventListener("pointerup", release, true);
  button.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", () => release(), {passive: true});

  button.addEventListener("click", event => {
    if (!readerMode() && performance.now() - lastTouchToggleAt < 500) {
      stopEvent(event);
      return;
    }
    if (!readerMode()) return;
    stopEvent(event);

    if (toggleControls.has(control)) {
      toggleControl(button, control);
      return;
    }

    if (!pulseControls.has(control) || !gameApi()?.control?.(control, true)) return;
    setHeld(button, true);
    const duration = control === "left" || control === "right" ? 1150 : control === "forward" ? 900 : 720;
    setTimeout(() => {
      gameApi()?.control?.(control, false);
      setHeld(button, false);
      if (control === "left" || control === "right") say(courseText());
    }, duration);
  }, true);
}

function statusText() {
  const current = state();
  const currentView = view();
  if (!current || !currentView) return "Операция ещё не запущена.";
  const timeText = current.timed ? `Осталось ${Math.ceil(currentView.remaining)} секунд.` : "Режим без ограничения времени.";
  const repairText = `Пробоина ${current.boat.leak.toFixed(1)}. Ремонтных пластин ${current.boat.repairPatches}.`;
  const assistText = currentView.navigation?.assistEnabled ? "Навигационный помощник включён." : "Навигационный помощник выключен.";
  return `${currentView.message} Скорость ${currentView.boat.speed.toFixed(1)} узла. Курс ${Math.round((currentView.boat.heading + 360) % 360)} градусов. Корпус ${Math.round(currentView.boat.hull)} процентов. Вода ${Math.round(currentView.boat.water)} процентов. ${repairText} Спасено ${currentView.rescued} из двух. ${assistText} ${timeText}`;
}

function syncControls() {
  const current = state();
  const currentView = view();
  if (!current) return;

  for (const control of toggleControls) {
    const active = Boolean(current.controls?.[control]);
    toggled.set(control, active);
    const id = Object.keys(controlMap).find(key => controlMap[key] === control);
    const button = id ? byId(id) : null;
    if (button) setHeld(button, active);
  }

  const rescueButton = byId("rescueButton");
  if (rescueButton) {
    const active = Boolean(current.controls.rescue);
    const text = active ? "Трос подан — нажми для отмены" : "Подать спасательный трос";
    if (rescueButton.textContent !== text) rescueButton.textContent = text;
    rescueButton.setAttribute("aria-label", active
      ? "Спасательный трос активен. Нажми для отмены"
      : "Подать спасательный трос. Подойди ближе двенадцати метров и снизь скорость ниже четырёх узлов");
  }

  const pumpButton = byId("pumpButton");
  if (pumpButton) {
    const text = current.controls.pump ? "Насос работает — нажми для выключения" : "Включить насос";
    if (pumpButton.textContent !== text) pumpButton.textContent = text;
  }

  const repairHullButton = byId("repairHullButton");
  if (repairHullButton) {
    const captainLocked = current.mode === "coop" && document.body.dataset.role === "captain";
    repairHullButton.setAttribute("aria-disabled", String(captainLocked));
    const patches = current.boat.repairPatches ?? 0;
    const text = current.controls.hullRepair ? "Заделка пробоины выполняется — нажми для отмены" : `Заделать пробоину — пластин ${patches}`;
    if (repairHullButton.textContent !== text) repairHullButton.textContent = text;
  }

  const assistButton = byId("assistButton");
  if (assistButton && currentView?.navigation) {
    const enabled = Boolean(currentView.navigation.assistEnabled);
    assistButton.setAttribute("aria-pressed", String(enabled));
    assistButton.textContent = `Навигационный помощник: ${enabled ? "включён" : "выключен"}`;
  }

  const time = byId("time");
  if (time && !current.timed && time.textContent !== "Без лимита") time.textContent = "Без лимита";
}

byId("paceFree")?.addEventListener("click", () => setPace(false));
byId("paceTimed")?.addEventListener("click", () => setPace(true));
for (const id of ["soloButton", "hostPeer", "joinPeer", "hostLocal", "joinLocal"]) {
  byId(id)?.addEventListener("click", applyPaceToNextSession, true);
}
for (const [id, control] of Object.entries(controlMap)) bindReliableControl(byId(id), control);

byId("statusButton")?.addEventListener("click", event => {
  if (!state()) return;
  stopEvent(event);
  say(statusText());
}, true);

byId("actionHintButton")?.addEventListener("click", event => {
  stopEvent(event);
  say(situationHint());
}, true);

byId("assistButton")?.addEventListener("click", event => {
  stopEvent(event);
  gameApi()?.command?.("assist-toggle");
  setTimeout(() => say(state()?.message || "Навигационный помощник переключён."), 40);
}, true);

setInterval(syncControls, 220);
setPace(false);
window.__echoGameplayV6 = {situationHint, statusText, syncControls};
