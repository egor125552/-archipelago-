import "./keyboard-controls-v1.js?v=2";

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

function installFreeRoamEntry() {
  if (byId("freeRoamEntry")) return;
  const start = byId("startScreen");
  const progression = byId("progressionPanel");
  if (!start || !progression) return;
  const section = document.createElement("section");
  section.id = "freeRoamEntry";
  section.className = "panel";
  section.innerHTML = `
    <p class="eyebrow">Новый режим</p>
    <h2>Свободная бухта</h2>
    <p>Две отдельные лодки без заданий: таран, физический буксир, выход на берег, плавание, крыши лодок и угон оставленного катера.</p>
    <a href="/free-roam.html" class="free-roam-link">Открыть свободный онлайн-мир</a>
  `;
  progression.parentNode.insertBefore(section, progression);
  const style = document.createElement("style");
  style.textContent = `.free-roam-link{display:block;min-height:3.4rem;padding:.9rem;border-radius:1rem;background:var(--accent);color:#00141b;text-align:center;font-weight:900;text-decoration:none}.free-roam-link:focus-visible{outline:4px solid var(--focus);outline-offset:3px}`;
  document.head.appendChild(style);
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
    const water = Math.round(view.boat.water || 0);
    const leak = Number(view.boat.leak || 0).toFixed(1);
    const pump = view.boat.pumpActive ? "да" : "нет";
    setText("floodEmergencyStatus", `Авария: ${seconds} с. Вода ${water}, цель ${view.damageControl.recoveryWaterTarget}. Корпус ${Math.round(view.boat.hull || 0)}, цель ${view.damageControl.recoveryHullTarget}. Течь ${leak}. Насос: ${pump}.`);
  }
}

byId("safetyButton")?.addEventListener("click", event => {
  event.preventDefault();
  event.stopImmediatePropagation();
  window.__echoArchipelago?.command?.("safety-toggle");
  syncV9();
}, true);

installFreeRoamEntry();
setInterval(syncV9, 180);
window.__echoGameplayV9 = {sync: syncV9};
