"use strict";

const PUMP_ON_TEXT = "Насос включён.";
const normalize = value => String(value || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

function activeBoatId(world, playerIndex) {
  const id = world?.players?.[playerIndex]?.activeBoat;
  return Number.isInteger(id) ? id : null;
}

function modulePumpState(boat) {
  const modules = boat?.vesselRuntimeState?.staticModules;
  if (!modules || typeof modules !== "object") return null;
  const pump = modules["bilge-pump"];
  return pump && typeof pump === "object" ? pump : null;
}

export function pumpCommandContext(world, playerIndex, {recentBoatId = null} = {}) {
  const boatId = activeBoatId(world, playerIndex);
  if (boatId == null) {
    const recent = Number.isInteger(recentBoatId) ? world?.boats?.[recentBoatId] : null;
    if (recent?.sunk) {
      return {
        boatId: recentBoatId,
        state: "blocked",
        reason: "sunk",
        text: "Насос включить невозможно: судно затонуло.",
      };
    }
    return {
      boatId: null,
      state: "blocked",
      reason: "not-aboard",
      text: "Насос включить невозможно: ты не на судне.",
    };
  }

  const boat = world?.boats?.[boatId] || null;
  if (!boat || boat.sunk) {
    return {
      boatId,
      state: "blocked",
      reason: "sunk",
      text: "Насос включить невозможно: судно затонуло.",
    };
  }

  const pump = modulePumpState(boat);
  if (!pump) return {boatId, state: "legacy", reason: null, text: null};

  const health = Number(pump.health);
  if (Number.isFinite(health) && health <= 0) {
    return {
      boatId,
      state: "blocked",
      reason: "damaged",
      text: "Насос включить невозможно: трюмная помпа повреждена. Её нужно отремонтировать.",
    };
  }
  if (pump.repairActive === true) {
    return {
      boatId,
      state: "blocked",
      reason: "repairing",
      text: "Насос включить невозможно: трюмная помпа сейчас ремонтируется.",
    };
  }
  if (pump.enabled === false) {
    return {
      boatId,
      state: "blocked",
      reason: "disabled",
      text: "Насос включить невозможно: трюмная помпа сейчас недоступна.",
    };
  }
  if (boat.pumpActive === true) return {boatId, state: "active", reason: null, text: PUMP_ON_TEXT};

  // A modular vessel has accepted only a request at this point. Do not claim
  // that the physical pump is running until the authoritative vessel tick has
  // replicated pumpActive=true and emitted its start transition.
  return {boatId, state: "pending", reason: null, text: null};
}

export function pumpFeedbackDecision(text, world, playerIndex, options = {}) {
  if (normalize(text) !== normalize(PUMP_ON_TEXT)) return {mode: "pass", text: String(text || "")};
  const context = pumpCommandContext(world, playerIndex, options);
  if (context.state === "blocked") return {mode: "replace", text: context.text, context};
  if (context.state === "pending") return {mode: "suppress", text: "", context};
  return {mode: "pass", text: PUMP_ON_TEXT, context};
}

export function vesselScopedPumpShouldReset(previousBoatId, nextBoatId, pumpRequested) {
  return Boolean(pumpRequested && previousBoatId !== nextBoatId);
}

export function installPumpCommandPolicy(global = globalThis) {
  if (!global || global.__echoPumpCommandPolicyV1Installed) return global?.__echoPumpCommandPolicyV1State || null;

  let previousBoatId;
  let recentBoatId = null;
  let resetQueued = false;

  const api = () => global.__freeRoam;
  const snapshot = () => {
    const game = api();
    const world = game?.getWorld?.() || null;
    const playerIndex = Number(game?.playerIndex?.()) || 0;
    return {game, world, playerIndex};
  };

  function queuePumpReset() {
    if (resetQueued) return;
    resetQueued = true;
    queueMicrotask(() => {
      resetQueued = false;
      const game = api();
      if (game?.input?.pump) game.setControl?.("pump", false);
    });
  }

  function decision(text) {
    const {world, playerIndex} = snapshot();
    return pumpFeedbackDecision(text, world, playerIndex, {recentBoatId});
  }

  const synth = global.speechSynthesis;
  if (synth && typeof synth.speak === "function" && !synth.__echoPumpCommandSpeechV1) {
    const previousSpeak = synth.speak.bind(synth);
    const wrappedSpeak = utterance => {
      const result = decision(utterance?.text);
      if (result.mode === "suppress") {
        queueMicrotask(() => {
          try { utterance?.onend?.({type: "end", suppressed: true, pumpPending: true}); } catch (_) {}
        });
        return undefined;
      }
      if (result.mode === "replace") {
        queuePumpReset();
        try { utterance.text = result.text; } catch (_) {}
      }
      return previousSpeak(utterance);
    };
    try {
      Object.defineProperty(synth, "speak", {configurable: true, value: wrappedSpeak});
      Object.defineProperty(synth, "__echoPumpCommandSpeechV1", {configurable: true, value: true});
    } catch (_) {
      try {
        synth.speak = wrappedSpeak;
        synth.__echoPumpCommandSpeechV1 = true;
      } catch (_) {}
    }
  }

  const prototype = global.Node?.prototype;
  if (prototype && !prototype.__echoPumpCommandTextV1) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "textContent");
    if (descriptor?.get && descriptor?.set && descriptor.configurable !== false) {
      Object.defineProperty(prototype, "textContent", {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) {
          const text = String(value ?? "");
          if ((this?.id === "live" || this?.id === "message") && normalize(text) === normalize(PUMP_ON_TEXT)) {
            const result = decision(text);
            if (result.mode === "suppress") return descriptor.set.call(this, "");
            if (result.mode === "replace") {
              queuePumpReset();
              return descriptor.set.call(this, result.text);
            }
          }
          return descriptor.set.call(this, value);
        },
      });
      Object.defineProperty(prototype, "__echoPumpCommandTextV1", {configurable: true, value: true});
    }
  }

  function enforceVesselScope() {
    const {game, world, playerIndex} = snapshot();
    const nextBoatId = activeBoatId(world, playerIndex);
    if (nextBoatId != null) recentBoatId = nextBoatId;

    if (previousBoatId === undefined) previousBoatId = nextBoatId;
    else if (vesselScopedPumpShouldReset(previousBoatId, nextBoatId, game?.input?.pump)) {
      game?.setControl?.("pump", false);
    }
    previousBoatId = nextBoatId;

    if (game?.input?.pump) {
      const context = pumpCommandContext(world, playerIndex, {recentBoatId});
      if (context.state === "blocked") game.setControl?.("pump", false);
    }
    global.requestAnimationFrame?.(enforceVesselScope);
  }

  global.requestAnimationFrame?.(enforceVesselScope);

  const state = Object.freeze({
    context() {
      const {world, playerIndex} = snapshot();
      return pumpCommandContext(world, playerIndex, {recentBoatId});
    },
    decision,
  });
  try {
    Object.defineProperty(global, "__echoPumpCommandPolicyV1Installed", {configurable: true, value: true});
    Object.defineProperty(global, "__echoPumpCommandPolicyV1State", {configurable: true, value: state});
  } catch (_) {}
  return state;
}

if (typeof window !== "undefined") installPumpCommandPolicy(globalThis);
