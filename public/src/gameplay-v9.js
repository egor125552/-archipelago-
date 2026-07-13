"use strict";

const byId = id => document.getElementById(id);
const cache = new Map();

function setText(id, value) {
  const text = String(value ?? "");
  if (cache.get(`text:${id}`) === text) return;
  cache.set(`text:${id}`, text);
  const node = byId(id);
  if (node) node.textContent = text;
}

function setHidden(id, hidden) {
  const value = Boolean(hidden);
  if (cache.get(`hidden:${id}`) === value) return;
  cache.set(`hidden:${id}`, value);
  const node = byId(id);
  if (node) node.hidden = value;
}

function syncV9() {
  const api = window.__echoArchipelago;
  const view = api?.getView?.();
  if (!view) return;

  const motion = view.boat?.motionState || (Math.abs(view.boat?.speed || 0) < 0.2 ? "стоит" : "идёт");
  setText("movementState", motion);

  const safety = Boolean(view.training?.safetyEnabled);
  const safetyButton = byId("safetyButton");
  if (safetyButton) {
    const visible = view.mode === "solo";
    setHidden("safetyButton", !visible);
    safetyButton.setAttribute("aria-pressed", String(safety));
    setText("safetyButton", `Учебная страховка: ${safety ? "включена" : "выключена"}`);
  }

  const emergency = Boolean(view.damageControl?.floodEmergency);
  setHidden("floodEmergencyStatus", !emergency);
  if (emergency) {
    const seconds = Math.max(0, Math.ceil(view.damageControl.floodEmergencyRemaining || 0));
    const cause = view.damageControl.emergencyCause === "wrecked" ? "Критическое повреждение корпуса" : "Полное затопление";
    const water = Math.round(view.boat.water || 0);
    const leak = Number(view.boat.leak || 0).toFixed(1);
    const pump = view.boat.pumpActive ? "работает" : "ВЫКЛЮЧЕН";
    setText("floodEmergencyStatus", `${cause}. Осталось ${seconds} секунд. Насос ${pump}. Вода ${water}, нужно не выше ${view.damageControl.recoveryWaterTarget}. Течь ${leak}, нужно не выше ${view.damageControl.recoveryLeakTarget.toFixed(1)}. Корпус ${Math.round(view.boat.hull || 0)}, нужно не ниже ${view.damageControl.recoveryHullTarget}.`);
  }
}

byId("safetyButton")?.addEventListener("click", event => {
  event.preventDefault();
  event.stopImmediatePropagation();
  window.__echoArchipelago?.command?.("safety-toggle");
  syncV9();
}, true);

setInterval(syncV9, 180);
window.__echoGameplayV9 = {sync: syncV9};
