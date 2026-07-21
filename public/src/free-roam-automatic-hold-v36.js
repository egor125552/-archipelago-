"use strict";

export function shouldHoldAutomaticFire({pointers, weaponText, targetMenuOpen = false}) {
  return Number(pointers) === 3
    && /^автомат(?:\b|,)/i.test(String(weaponText || "").trim())
    && !targetMenuOpen;
}

export function installAutomaticHoldFire(doc = document) {
  const game = doc.getElementById("game");
  const attackButton = doc.getElementById("attackButton");
  const weaponValue = doc.getElementById("weaponValue");
  const targetButton = doc.getElementById("targetButton");
  if (!game || !attackButton || !weaponValue || !targetButton) return null;

  const activeTouches = new Set();
  const syntheticPointerId = 9036;
  let firing = false;
  let consumedAutomaticGesture = false;

  const targetMenuOpen = () => targetButton.getAttribute("aria-pressed") === "true";
  const automaticReady = () => shouldHoldAutomaticFire({
    pointers: activeTouches.size,
    weaponText: weaponValue.textContent,
    targetMenuOpen: targetMenuOpen(),
  });

  function dispatchAttack(type) {
    attackButton.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: syntheticPointerId,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerdown" ? 1 : 0,
    }));
  }

  function startFiring() {
    if (firing || !automaticReady()) return false;
    firing = true;
    consumedAutomaticGesture = true;
    dispatchAttack("pointerdown");
    return true;
  }

  function stopFiring() {
    if (!firing) return false;
    firing = false;
    dispatchAttack("pointerup");
    return true;
  }

  function forceAttackReleasedAfterGesture() {
    queueMicrotask(() => {
      dispatchAttack("pointerdown");
      dispatchAttack("pointerup");
    });
  }

  function pointerDown(event) {
    if (event.pointerType !== "touch" || event.target.closest("button, a, summary, input, textarea, select")) return;
    activeTouches.add(event.pointerId);
    if (activeTouches.size === 3) startFiring();
    else if (activeTouches.size > 3) stopFiring();
  }

  function pointerFinished(event) {
    if (event.pointerType !== "touch" || !activeTouches.has(event.pointerId)) return;
    activeTouches.delete(event.pointerId);
    if (activeTouches.size !== 3) stopFiring();
    if (activeTouches.size === 0 && consumedAutomaticGesture) {
      consumedAutomaticGesture = false;
      forceAttackReleasedAfterGesture();
    }
  }

  game.addEventListener("pointerdown", pointerDown, true);
  game.addEventListener("pointerup", pointerFinished, true);
  game.addEventListener("pointercancel", pointerFinished, true);

  const observer = new MutationObserver(() => {
    if (firing && !automaticReady()) stopFiring();
  });
  observer.observe(weaponValue, {childList: true, subtree: true, characterData: true});
  observer.observe(targetButton, {attributes: true, attributeFilter: ["aria-pressed"]});

  return {
    stop() {
      stopFiring();
      observer.disconnect();
      game.removeEventListener("pointerdown", pointerDown, true);
      game.removeEventListener("pointerup", pointerFinished, true);
      game.removeEventListener("pointercancel", pointerFinished, true);
    },
    activeTouches,
    isFiring: () => firing,
  };
}

if (typeof document !== "undefined") installAutomaticHoldFire(document);
