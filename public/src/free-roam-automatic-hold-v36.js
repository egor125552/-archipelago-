"use strict";

const ARM_DELAY_MS = 90;
const RANGED_WEAPONS = new Set(["pistol", "automatic"]);

export function shouldHoldRangedFire({pointers, weaponText, targetMenuOpen = false}) {
  return Number(pointers) === 3
    && /^(?:пистолет|автомат)(?:\b|,)/i.test(String(weaponText || "").trim())
    && !targetMenuOpen;
}

export const shouldHoldAutomaticFire = shouldHoldRangedFire;

export function installAutomaticHoldFire(doc = document) {
  const game = doc.getElementById("game");
  const weaponValue = doc.getElementById("weaponValue");
  const targetButton = doc.getElementById("targetButton");
  if (!game || !weaponValue || !targetButton) return null;

  const activeTouches = new Set();
  let firing = false;
  let consumedRangedGesture = false;
  let blockedByExtraFinger = false;
  let armTimer = 0;

  const targetMenuOpen = () => targetButton.getAttribute("aria-pressed") === "true";

  function currentWeapon() {
    const api = globalThis.__freeRoam;
    const world = api?.getWorld?.();
    const playerIndex = api?.playerIndex?.() ?? 0;
    return world?.players?.[playerIndex]?.combat?.equipped || "";
  }

  function rangedReady() {
    return activeTouches.size === 3
      && RANGED_WEAPONS.has(currentWeapon())
      && !targetMenuOpen();
  }

  function setAttack(active) {
    const api = globalThis.__freeRoam;
    return api?.setControl?.("attack", Boolean(active)) ?? false;
  }

  function cancelArm() {
    if (!armTimer) return;
    clearTimeout(armTimer);
    armTimer = 0;
  }

  function startFiring() {
    if (firing || blockedByExtraFinger || !rangedReady()) return false;
    firing = true;
    consumedRangedGesture = true;
    setAttack(true);
    return true;
  }

  function scheduleFiring() {
    cancelArm();
    if (blockedByExtraFinger || !rangedReady()) return;
    armTimer = setTimeout(() => {
      armTimer = 0;
      startFiring();
    }, ARM_DELAY_MS);
  }

  function stopFiring() {
    cancelArm();
    if (!firing) return false;
    firing = false;
    setAttack(false);
    return true;
  }

  function cancelConsumedGestureRelease(event) {
    // The main gesture recognizer classifies a completed three-finger hold on
    // release. Feed it a cancellation instead, otherwise it starts a delayed
    // 680 ms attack pulse after the real held fire has already stopped.
    const cancellation = new PointerEvent("pointercancel", {
      bubbles: true,
      cancelable: true,
      pointerId: event.pointerId,
      pointerType: "touch",
      isPrimary: event.isPrimary,
      clientX: event.clientX,
      clientY: event.clientY,
      button: 0,
      buttons: 0,
    });
    game.dispatchEvent(cancellation);
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function pointerDown(event) {
    if (event.pointerType !== "touch" || event.target.closest("button, a, summary, input, textarea, select")) return;
    activeTouches.add(event.pointerId);
    if (activeTouches.size > 3) {
      blockedByExtraFinger = true;
      stopFiring();
      return;
    }
    if (activeTouches.size === 3) scheduleFiring();
  }

  function pointerFinished(event) {
    if (event.pointerType !== "touch" || !activeTouches.has(event.pointerId)) return;
    const finalPointer = activeTouches.size === 1;
    activeTouches.delete(event.pointerId);
    if (activeTouches.size !== 3) stopFiring();
    if (!finalPointer) return;

    const consumed = consumedRangedGesture;
    blockedByExtraFinger = false;
    consumedRangedGesture = false;
    if (consumed && event.type === "pointerup") cancelConsumedGestureRelease(event);
  }

  game.addEventListener("pointerdown", pointerDown, true);
  game.addEventListener("pointerup", pointerFinished, true);
  game.addEventListener("pointercancel", pointerFinished, true);

  const observer = new MutationObserver(() => {
    if (firing && (!RANGED_WEAPONS.has(currentWeapon()) || targetMenuOpen())) stopFiring();
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
    currentWeapon,
    isFiring: () => firing,
  };
}

if (typeof document !== "undefined") installAutomaticHoldFire(document);
