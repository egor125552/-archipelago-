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
let readerBrakeTimer = null;

function gameApi() { return window.__echoArchipelago; }
function state() { return gameApi()?.getState?.() || null; }
function view() { return gameApi()?.getView?.() || null; }
function readerMode() { return document.body.dataset.accessibility === "reader"; }

function say(text) {
  if (!text) return;
  const api = gameApi();
  if (typeof api?.announce === "function") {
    api.announce(text);
    return;
  }
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
    ? "Трос подан. В зоне четырнадцати метров лодка удерживается автоматически; дождись сообщения «Человек на борту»."
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

  if (currentView.damageControl?.floodEmergency) {
    const seconds = Math.max(0, Math.ceil(currentView.damageControl.floodEmergencyRemaining || 0));
    const waterTarget = currentView.damageControl.recoveryWaterTarget;
    const leakTarget = currentView.damageControl.recoveryLeakTarget;
    const hullTarget = currentView.damageControl.recoveryHullTarget;
    const pumpActive = Boolean(currentView.boat.pumpActive);
    if (!pumpActive) return `Авария, осталось ${seconds} секунд. Сначала включи насос. Мотор пока не трогай.`;
    if (current.controls.hullRepair) {
      const percent = Math.round((Number(current.boat.hullRepairProgress) || 0) / 3.1 * 100);
      return `Насос работает. Пластина устанавливается: ${Math.min(99, percent)} процентов. Осталось ${seconds} секунд.`;
    }
    if (hull < hullTarget && patches > 0) {
      return `Насос работает. Корпус ${Math.round(hull)} процентов, нужно не ниже ${hullTarget}. Нажми Заделать пробоину.`;
    }
    if (hull < hullTarget) {
      return `Корпус ниже аварийного минимума, а пластин больше нет. Продолжай откачку, но без пластины лодку стабилизировать нельзя.`;
    }
    if (leak > leakTarget && patches > 0) {
      return `Насос работает. Течь ${leak.toFixed(1)}, нужно не выше ${leakTarget.toFixed(1)}. Нажми Заделать пробоину; пластин осталось ${patches}.`;
    }
    if (leak > leakTarget) {
      return `Насос работает, пластин больше нет. Продолжай откачку: течь ${leak.toFixed(1)}, нужно не выше ${leakTarget.toFixed(1)}. Осталось ${seconds} секунд.`;
    }
    if (water > waterTarget) {
      return `Течь взята под контроль. Не выключай насос: вода ${Math.round(water)} процентов, нужно не выше ${waterTarget}. Осталось ${seconds} секунд.`;
    }
    return "Лодка стабилизирована. Дождись окончания аварийного режима, затем запускай двигатель.";
  }

  if ((leak > 0.2 || hull < 70) && patches > 0) {
    if (speed > 2.2) return `Корпус повреждён. Снизь скорость с ${speed.toFixed(1)} примерно до двух узлов, затем нажми Заделать пробоину.`;
    return "Лодка почти остановлена. Нажми Заделать пробоину. После установки пластины включи насос, чтобы убрать воду.";
  }
  if (water > 30) return `В лодке ${Math.round(water)} процентов воды. Включи насос повторным нажатием и выключи, когда уровень снизится.`;
  if (currentView.riskRoute?.active) {
    const failed = currentView.riskRoute.gateFailed
      ? " На этом подходе уже было столкновение: проход можно закончить, но бонус не начислится."
      : ` Чистое прохождение даст 150 очков и 100 жетонов после победы.`;
    return `Рискованный маршрут: ${currentView.riskRoute.gateLabel}, примерно ${Math.round(currentView.navigation?.guideDistance || 0)} метров. Держи высокий маяк по центру вручную; автоподруливание временно приостановлено.${failed}`;
  }
  if (current.rescued < 2) {
    const targetDistance = currentView.navigation?.guideDistance ?? currentView.navigation?.targetDistance ?? currentView.nearestSurvivorDistance;
    const angle = currentView.navigation?.targetRelativeAngle;
    if (targetDistance == null) return "Нажми сонар, чтобы найти следующую цель.";
    if (targetDistance > currentView.rescueRadius + 1) {
      const direction = angle == null || Math.abs(angle) < 10 ? "прямо" : angle < 0 ? "слева" : "справа";
      const label = currentView.navigation?.guideIsWaypoint ? "Текущая контрольная точка" : "Ближайшая цель";
      return `${label} ${direction}, примерно ${Math.round(targetDistance)} метров. Следуй стереомаяку.`;
    }
    if (speed > currentView.rescueSpeedLimit) return `Человек рядом, но скорость ${speed.toFixed(1)} узла. Снизь её до ${currentView.rescueSpeedLimit.toFixed(1)}, затем один раз нажми трос.`;
    const percent = Math.round((currentView.rescueProgress || 0) * 100);
    return percent > 0
      ? `Трос натянут на ${percent} процентов. Не нажимай повторно и держи лодку почти неподвижно.`
      : "Человек в зоне троса, маяк должен замолчать. Один раз нажми Подать спасательный трос и дождись сообщения о завершении.";
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
  button.addEventListener("pointerleave", release, true);
  button.addEventListener("lostpointercapture", release, true);
  window.addEventListener("pointerup", event => {
    if (pointerId === event.pointerId) release(event);
  }, true);
  window.addEventListener("pointercancel", event => {
    if (pointerId === event.pointerId) release(event);
  }, true);
  window.addEventListener("blur", () => release(), {passive: true});
  window.addEventListener("pagehide", () => release(), {passive: true});
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) release();
  }, {passive: true});

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
    if (control === "reverse") {
      if (readerBrakeTimer != null) clearInterval(readerBrakeTimer);
      const startedAt = performance.now();
      readerBrakeTimer = setInterval(() => {
        const current = state();
        const stopped = !current || current.phase !== "playing" || Number(current.boat?.speed) <= 0.25;
        const timedOut = performance.now() - startedAt >= 2400;
        if (!stopped && !timedOut) return;
        clearInterval(readerBrakeTimer);
        readerBrakeTimer = null;
        gameApi()?.control?.(control, false);
        setHeld(button, false);
        if (current?.phase === "playing") say("Лодка остановлена обычным тормозом.");
      }, 60);
      return;
    }
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
  const levelText = currentView.progression
    ? `Уровень ${currentView.progression.level}, ${currentView.progression.operationName}. ${currentView.boat.modelName}.`
    : "";
  const armorText = currentView.boat.armorMax > 0
    ? `Броня ${Math.ceil(currentView.boat.armor)} из ${Math.ceil(currentView.boat.armorMax)}.`
    : "Брони нет.";
  const brakeText = currentView.progression?.coastBrakeActive
    ? `Автотормоз остановит лодку примерно через ${Math.ceil(currentView.progression.coastBrakeRemaining)} секунд.`
    : "";
  const emergencyText = currentView.damageControl?.floodEmergency
    ? `Аварийный режим. Осталось ${Math.ceil(currentView.damageControl.floodEmergencyRemaining)} секунд. Для спасения: вода не выше ${currentView.damageControl.recoveryWaterTarget}, течь не выше ${currentView.damageControl.recoveryLeakTarget.toFixed(1)}, корпус не ниже ${currentView.damageControl.recoveryHullTarget}. Насос ${currentView.boat.pumpActive ? "работает" : "выключен"}.`
    : "";
  const pendingText = currentView.riskRoute?.selectionPending
    ? ` После следующего сонара включится ${currentView.riskRoute.selectedRisk ? "рискованный" : "обычный"} режим.`
    : "";
  const riskText = currentView.riskRoute?.enabled
    ? currentView.riskRoute.active
      ? `Рискованный маршрут активен: ${currentView.riskRoute.gateLabel}. Чистых ворот ${currentView.riskRoute.cleanGates}.${pendingText}`
      : `Текущий режим рискованный. Чистых ворот ${currentView.riskRoute.cleanGates}.${pendingText}`
    : `Текущий маршрут обычный.${pendingText}`;
  return `${currentView.message} ${emergencyText} ${levelText} Скорость ${currentView.boat.speed.toFixed(1)} узла. Курс ${Math.round((currentView.boat.heading + 360) % 360)} градусов. Корпус ${Math.round(currentView.boat.hull)} процентов. ${armorText} Вода ${Math.round(currentView.boat.water)} процентов. ${repairText} Спасено ${currentView.rescued} из двух. ${assistText} ${riskText} ${brakeText} ${timeText}`;
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
      : "Подать спасательный трос. Подойди ближе четырнадцати метров и снизь скорость до четырёх узлов");
  }

  const pumpButton = byId("pumpButton");
  if (pumpButton) {
    const text = current.controls.pump
      ? "Ручной насос усилен — нажми для выключения"
      : currentView?.boat?.pumpActive
        ? "Помощник откачивает — нажми для усиления"
        : "Включить насос";
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
    assistButton.textContent = currentView.riskRoute?.active
      ? "Навигационный помощник: пауза на рискованном проходе"
      : `Навигационный помощник: ${enabled ? "включён" : "выключен"}`;
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
