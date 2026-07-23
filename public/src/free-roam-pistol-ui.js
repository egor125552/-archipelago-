"use strict";

(() => {
  const LABELS = Object.freeze({
    fists: "кулаки",
    knife: "нож",
    pistol: "пистолет",
    automatic: "автомат",
  });

  function sync() {
    const api = globalThis.__freeRoam;
    const world = api?.getWorld?.();
    const playerIndex = api?.playerIndex?.() ?? 0;
    const combat = world?.players?.[playerIndex]?.combat;
    if (!combat) return;
    const attack = document.getElementById("attackButton");
    const weapon = document.getElementById("weaponButton");
    const weaponValue = document.getElementById("weaponValue");
    if (attack && combat.equipped === "pistol" && attack.textContent !== "Огонь") attack.textContent = "Огонь";
    const label = LABELS[combat.equipped] || combat.equipped || "кулаки";
    if (weapon && weapon.textContent !== `Оружие: ${label}`) weapon.textContent = `Оружие: ${label}`;
    if (weaponValue && weaponValue.textContent !== label) weaponValue.textContent = label;
  }

  const observer = new MutationObserver(sync);
  const start = () => {
    for (const id of ["attackButton", "weaponButton", "weaponValue"]) {
      const element = document.getElementById(id);
      if (element) observer.observe(element, {childList: true, subtree: true});
    }
    sync();
    setInterval(sync, 250);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, {once: true});
  else start();
})();
