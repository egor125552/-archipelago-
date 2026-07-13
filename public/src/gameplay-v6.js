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
    ? "Трос подан. Держи лодку спокойно."
    : "Трос убран.";
  if (control === "pump") return active ? "Ручной насос включён." : "Ручной насос выключен.";
  return active ? "Ремонт корпуса начат." : "Ремонт корпуса остановлен.";
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
    const hullTarget = currentView.damageControl.recoveryHullTarget;
    const pumpActive = Boolean(currentView.boat.pumpActive);
    if (water > waterTarget && !pumpActive) return `Авария: ${seconds} секунд. Включи насос.`;
    if (water > waterTarget && !current.controls.pump) return `Авария: ${seconds} секунд. Ручной насос быстрее.`;
    if (current.controls.hullRepair) {
      const percent = Math.round((Number(current.boat.hullRepairProgress) || 0) / 3.1 * 100);
      return `Авария: ${seconds} секунд. Пластина ${Math.min(99, percent)}%.`;
    }
    if (hull < hullTarget && patches > 0) {
      return `Авария: ${seconds} секунд. Корпус ${Math.round(hull)}. Нужно ${hullTarget}. Поставь пластину.`;
    }
    if (hull < hullTarget) {
      return `Нет пластин. Корпус ниже ${hullTarget}%.`;
    }
    if (water > waterTarget) {
      return `Авария: ${seconds} секунд. Вода ${Math.round(water)}. Нужно ${waterTarget}. Не выключай насос.`;
    }
    return "Лодка стабилизируется.";
  }

  if (currentView.debris?.removing) return `Обломок: ${Math.round(currentView.debris.progress)}%. Не двигайся.`;
  if (currentView.debris?.count) {
    if (speed > 0.25) return "В корпусе обломок. Остановись.";
    return "В корпусе обломок. Нажми «Извлечь».";
  }

  if ((leak > 0.2 || hull < 70) && patches > 0) {
    if (speed > 2.2) return "Снизь скорость до 2 узлов. Затем поставь пластину.";
    return "Поставь ремонтную пластину.";
  }
  if (water > 30) {
    if (currentView.pumpAssist?.enabled && currentView.boat.pumpActive && !current.controls.pump) {
      return `Вода ${Math.round(water)}%. Помощник качает. Ручной насос быстрее.`;
    }
    return `Вода ${Math.round(water)}%. Включи насос.`;
  }
  if (currentView.hunter?.active && currentView.hunter.distance < 45) {
    const side = currentView.hunter.relativeAngle < -12 ? "слева" : currentView.hunter.relativeAngle > 12 ? "справа" : "прямо";
    return `Преследователь ${side}, ${Math.round(currentView.hunter.distance)} м. Меняй курс или сбрось буй.`;
  }
  if (currentView.riskRoute?.active) {
    const failed = currentView.riskRoute.gateFailed ? " Бонус потерян." : "";
    return `Риск: ${currentView.riskRoute.gateLabel}, ${Math.round(currentView.navigation?.guideDistance || 0)} м. Держи маяк по центру.${failed}`;
  }
  if (current.rescued < 2) {
    const targetDistance = currentView.navigation?.guideDistance ?? currentView.navigation?.targetDistance ?? currentView.nearestSurvivorDistance;
    const angle = currentView.navigation?.targetRelativeAngle;
    if (targetDistance == null) return "Нажми сонар.";
    if (targetDistance > currentView.rescueRadius + 1) {
      const direction = angle == null || Math.abs(angle) < 10 ? "прямо" : angle < 0 ? "слева" : "справа";
      const label = currentView.navigation?.guideIsWaypoint ? "Проход" : "Цель";
      return `${label} ${direction}, ${Math.round(targetDistance)} м. Следуй маяку.`;
    }
    if (speed > currentView.rescueSpeedLimit) return `Человек рядом. Снизь скорость до ${currentView.rescueSpeedLimit.toFixed(1)}.`;
    const percent = Math.round((currentView.rescueProgress || 0) * 100);
    return percent > 0
      ? `Трос ${percent}%. Держи лодку спокойно.`
      : "Человек рядом. Подай трос.";
  }
  return "Люди на борту. Сонар укажет гавань.";
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
  if (currentView.damageControl?.floodEmergency) {
    return `Авария: ${Math.ceil(currentView.damageControl.floodEmergencyRemaining)} секунд. Вода ${Math.round(currentView.boat.water)}, нужно ${currentView.damageControl.recoveryWaterTarget}. Корпус ${Math.round(currentView.boat.hull)}, нужно ${currentView.damageControl.recoveryHullTarget}. Течь ${currentView.boat.leak.toFixed(1)}. Насос ${currentView.boat.pumpActive ? "включён" : "выключен"}.`;
  }
  const motorStopped = Boolean(currentView.waterEngine?.locked || currentView.boat.engineStalled);
  const parts = [
    `Скорость ${currentView.boat.speed.toFixed(1)}.`,
    `Корпус ${Math.round(currentView.boat.hull)}.`,
    `Вода ${Math.round(currentView.boat.water)}.`,
    `Топливо ${Math.round(currentView.boat.fuel)}.`,
    `Спасено ${currentView.rescued} из 2.`,
  ];
  if (motorStopped) parts.unshift("Мотор остановлен.");
  else parts.splice(1, 0, `Курс ${Math.round((currentView.boat.heading + 360) % 360)}.`, `Течь ${currentView.boat.leak.toFixed(1)}.`);
  if (currentView.debris?.count) parts.push(`Обломков: ${currentView.debris.count}.`);
  if (currentView.hunter?.active) parts.push(`Преследователь: ${Math.round(currentView.hunter.distance)} метров.`);
  if (current.timed) parts.push(`Время ${Math.ceil(currentView.remaining)} секунд.`);
  return parts.join(" ");
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
    const text = active ? "Трос подан — отменить" : "Подать спасательный трос";
    if (rescueButton.textContent !== text) rescueButton.textContent = text;
    rescueButton.setAttribute("aria-label", active
      ? "Спасательный трос активен. Нажми для отмены"
      : "Подать трос в зоне спасения");
  }

  const pumpButton = byId("pumpButton");
  if (pumpButton) {
    const text = current.controls.pump ? "Ручной насос: включён" : "Ручной насос: выключен";
    if (pumpButton.textContent !== text) pumpButton.textContent = text;
  }

  const pumpAssistButton = byId("pumpAssistButton");
  if (pumpAssistButton) {
    const available = Boolean(currentView?.pumpAssist?.available);
    const enabled = Boolean(currentView?.pumpAssist?.enabled);
    pumpAssistButton.hidden = !available;
    pumpAssistButton.setAttribute("aria-pressed", String(enabled));
    pumpAssistButton.textContent = `Автооткачка помощника: ${enabled ? "включена" : "выключена"}`;
  }

  const repairButton = byId("repairButton");
  if (repairButton) {
    if (currentView?.waterEngine?.locked) {
      repairButton.textContent = currentView.waterEngine.canRestart
        ? "Запустить мотор"
        : currentView.waterEngine.canService
          ? "Обслужить мотор"
          : currentView.boat.water > currentView.waterEngine.restartWater
            ? `Откачать воду до ${currentView.waterEngine.restartWater}%`
            : currentView.boat.fuel <= 0.01
              ? "Нет топлива"
              : "Стабилизировать лодку";
    } else {
      repairButton.textContent = currentView?.engineService?.active
        ? "Мотор обслуживается"
        : "Обслужить мотор";
    }
  }

  const repairHullButton = byId("repairHullButton");
  if (repairHullButton) {
    const captainLocked = current.mode === "coop" && document.body.dataset.role === "captain";
    repairHullButton.setAttribute("aria-disabled", String(captainLocked));
    const patches = current.boat.repairPatches ?? 0;
    const text = current.controls.hullRepair ? "Пластина ставится — отменить" : `Поставить пластину — ${patches}`;
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

byId("pumpAssistButton")?.addEventListener("click", event => {
  stopEvent(event);
  gameApi()?.command?.("pump-assist-toggle");
  setTimeout(() => say(state()?.message || "Автооткачка переключена."), 40);
}, true);

setInterval(syncControls, 220);
setPace(false);
window.__echoGameplayV6 = {situationHint, statusText, syncControls};
