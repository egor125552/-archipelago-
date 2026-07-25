from pathlib import Path

ROOT = Path.cwd()

LOCAL_ACTIONS = '"use strict";\n\nimport {CARGO_ACTION_RANGE, isFootDockZone} from "./free-roam-cargo-rules.js?v=32";\nimport {cargoSlotCost} from "./free-roam-cargo-traits.js?v=1";\n\nconst BRAKE_COOLDOWN_SECONDS = 12;\nconst SHORE_Y = 72;\n\nconst distance = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));\n\nfunction nearestBoat(world, point, maximum = Infinity) {\n  let found = null;\n  let best = maximum;\n  for (const boat of world?.boats || []) {\n    if (!boat || boat.sunk) continue;\n    const metres = distance(point, boat);\n    if (metres < best) {\n      best = metres;\n      found = boat;\n    }\n  }\n  return {boat: found, distance: best};\n}\n\nfunction crateById(world, id) {\n  return (world?.freeActivities?.crates || []).find(crate => crate?.id === id) || null;\n}\n\nfunction nearestWorldCrate(world, point, maximum = CARGO_ACTION_RANGE) {\n  let found = null;\n  let best = maximum;\n  for (const crate of world?.freeActivities?.crates || []) {\n    if (!crate || crate.state !== "world") continue;\n    const metres = distance(point, crate);\n    if (metres <= best + 0.001) {\n      best = metres;\n      found = crate;\n    }\n  }\n  return {crate: found, distance: best};\n}\n\nfunction occupiedCargoSlots(world, boat) {\n  return (boat?.cargo || []).reduce((sum, id) => sum + cargoSlotCost(crateById(world, id)), 0);\n}\n\nfunction canStow(world, boat, crate) {\n  return Boolean(\n    boat\n    && crate\n    && !boat.sunk\n    && occupiedCargoSlots(world, boat) + cargoSlotCost(crate) <= 5\n  );\n}\n\nfunction labelFor(crate) {\n  return crate?.label || ({\n    plates: "ремонтные пластины",\n    fuel: "топливо",\n    pump: "усилитель насоса",\n    valuable: "ценный груз",\n    knife: "нож",\n    automatic: "автомат",\n    ammo: "патроны",\n  })[crate?.kind] || "груз";\n}\n\nfunction cueOnly(cue = "action") {\n  return {\n    type: "cue-only",\n    cue,\n    expiryMs: 900,\n    suppressEvents: [],\n    announcement: "",\n  };\n}\n\nfunction jumpPrediction(world, playerIndex, startedAtMs) {\n  const player = world?.players?.[playerIndex];\n  if (!player?.combat?.alive || player.combat.knockedDown) return cueOnly("deny");\n\n  if (player.mode === "boat") {\n    const boat = world?.boats?.[player.activeBoat];\n    if (!boat || boat.sunk) return cueOnly("deny");\n    const remaining = (Number(boat.floatingBrakeReadyAt) || 0) - (Number(world?.time) || 0);\n    const moving = Math.abs(Number(boat.speed) || 0) > 0.16 || Math.abs(Number(boat.throttle) || 0) >= 0.05;\n    if (remaining > 0 || !moving) return cueOnly("deny");\n    return {\n      type: "brake",\n      cue: "brake",\n      playerIndex,\n      boatId: boat.id,\n      startedAtMs,\n      expiryMs: 1_500,\n      suppressEvents: ["anchor"],\n      announcement: "Плавучий тормоз.",\n    };\n  }\n\n  if (player.mode === "roof") {\n    const boat = world?.boats?.[player.activeBoat];\n    if (!boat) return cueOnly("deny");\n    return {\n      type: "roof-dismount",\n      cue: "roof",\n      playerIndex,\n      boatId: boat.id,\n      startedAtMs,\n      expiryMs: 1_500,\n      suppressEvents: ["jump"],\n      announcement: boat.y <= SHORE_Y + 20\n        ? "Ты спрыгнул с крыши на берег."\n        : "Ты спрыгнул с крыши в воду.",\n    };\n  }\n\n  if (["foot", "swim"].includes(player.mode)) {\n    const nearby = nearestBoat(world, player, 10);\n    if (nearby.boat) {\n      return {\n        type: "roof-climb",\n        cue: "roof",\n        playerIndex,\n        boatId: nearby.boat.id,\n        startedAtMs,\n        expiryMs: 1_500,\n        suppressEvents: ["roof"],\n        announcement: "Ты запрыгнул на крышу лодки.",\n      };\n    }\n    if (player.mode === "foot" && !player.airborne) {\n      return {\n        type: "jump",\n        cue: "jump",\n        playerIndex,\n        startedAtMs,\n        expiryMs: 1_100,\n        suppressEvents: ["jump"],\n        announcement: "Прыжок.",\n      };\n    }\n  }\n\n  return cueOnly("deny");\n}\n\nfunction cargoPrediction(world, playerIndex, startedAtMs) {\n  const player = world?.players?.[playerIndex];\n  const combat = player?.combat;\n  if (!player || !combat?.alive || combat.knockedDown) return cueOnly("deny");\n\n  const carried = crateById(world, combat.carriedCrate);\n  if (carried) {\n    if (isFootDockZone(player)) return cueOnly("action");\n\n    const other = world?.players?.[1 - playerIndex];\n    const otherPresent = world?.freeActivities?.presence?.[1 - playerIndex] !== false;\n    if (otherPresent && other?.combat?.alive && !other.combat.carriedCrate && distance(player, other) <= 4.5) {\n      return cueOnly("action");\n    }\n\n    const nearby = nearestBoat(world, player, 11);\n    if (canStow(world, nearby.boat, carried)) {\n      return {\n        type: "cargo-stow",\n        cue: "cargo-stow",\n        playerIndex,\n        crateId: carried.id,\n        boatId: nearby.boat.id,\n        startedAtMs,\n        expiryMs: 1_700,\n        suppressEvents: ["cargo-stowed"],\n        announcement: `Ящик погружён на лодку: ${labelFor(carried)}.`,\n      };\n    }\n\n    return {\n      type: "cargo-drop",\n      cue: "cargo-drop",\n      playerIndex,\n      crateId: carried.id,\n      startedAtMs,\n      expiryMs: 1_700,\n      suppressEvents: ["cargo-drop"],\n      announcement: "Ты положил груз рядом.",\n    };\n  }\n\n  const nearest = nearestWorldCrate(world, player);\n  if (!nearest.crate) return cueOnly("action");\n  if (nearest.crate.contractCategory === "salvage" && !nearest.crate.extracted) return cueOnly("action");\n\n  if (player.mode === "boat") {\n    const boat = world?.boats?.[player.activeBoat];\n    if (!canStow(world, boat, nearest.crate)) return cueOnly("deny");\n    return {\n      type: "cargo-stow",\n      cue: "cargo-stow",\n      playerIndex,\n      crateId: nearest.crate.id,\n      boatId: boat.id,\n      startedAtMs,\n      expiryMs: 1_700,\n      suppressEvents: ["cargo-stowed"],\n      announcement: `Ящик погружён на лодку: ${labelFor(nearest.crate)}.`,\n    };\n  }\n\n  return {\n    type: "cargo-pickup",\n    cue: "cargo-pickup",\n    playerIndex,\n    crateId: nearest.crate.id,\n    startedAtMs,\n    expiryMs: 1_700,\n    suppressEvents: ["cargo-pickup"],\n    announcement: `Ты поднял: ${labelFor(nearest.crate)}.`,\n  };\n}\n\nexport function createLocalActionPrediction(world, playerIndex, actionName, startedAtMs = performance.now()) {\n  if (!world) return null;\n  if (actionName === "jump") return jumpPrediction(world, playerIndex, startedAtMs);\n  if (actionName === "action") return cargoPrediction(world, playerIndex, startedAtMs);\n  return null;\n}\n\nfunction applyJump(world, prediction, nowMs) {\n  const player = world?.players?.[prediction.playerIndex];\n  if (!player || player.mode !== "foot") return false;\n  const elapsed = Math.max(0, (Number(nowMs) - Number(prediction.startedAtMs)) / 1_000);\n  const velocity = 5.8 - 15.5 * elapsed;\n  const height = 0.04 + 5.8 * elapsed - 7.75 * elapsed * elapsed;\n  if (height <= 0 && velocity < 0) {\n    player.airborne = false;\n    player.jumpHeight = 0;\n    player.__localJumpVelocity = 0;\n    return true;\n  }\n  player.airborne = true;\n  player.jumpHeight = Math.max(0.04, height);\n  player.__localJumpVelocity = velocity;\n  return true;\n}\n\nfunction applyRoofClimb(world, prediction) {\n  const player = world?.players?.[prediction.playerIndex];\n  const boat = world?.boats?.find(candidate => candidate?.id === prediction.boatId);\n  if (!player || !boat || boat.sunk) return false;\n  player.mode = "roof";\n  player.activeBoat = boat.id;\n  player.x = boat.x;\n  player.y = boat.y;\n  player.heading = boat.heading;\n  return true;\n}\n\nfunction applyRoofDismount(world, prediction) {\n  const player = world?.players?.[prediction.playerIndex];\n  const boat = world?.boats?.find(candidate => candidate?.id === prediction.boatId);\n  if (!player || !boat) return false;\n  player.mode = boat.y <= SHORE_Y + 20 ? "foot" : "swim";\n  player.activeBoat = null;\n  player.x = (Number(boat.x) || Number(player.x) || 0) + 7;\n  player.y = player.mode === "foot" ? SHORE_Y - 5 : (Number(boat.y) || Number(player.y) || 0) + 8;\n  player.airborne = false;\n  player.jumpHeight = 0;\n  return true;\n}\n\nfunction applyBrake(world, prediction) {\n  const player = world?.players?.[prediction.playerIndex];\n  const boat = world?.boats?.find(candidate => candidate?.id === prediction.boatId);\n  if (!player || !boat || player.mode !== "boat" || player.activeBoat !== boat.id) return false;\n  const direction = Math.sign(Number(boat.speed) || 0);\n  boat.speed = direction * Math.min(0.12, Math.abs(Number(boat.speed) || 0) * 0.08);\n  boat.throttle = 0;\n  boat.rudder = 0;\n  boat.floatingBrakeReadyAt = (Number(world?.time) || 0) + BRAKE_COOLDOWN_SECONDS;\n  player.x = boat.x;\n  player.y = boat.y;\n  player.heading = boat.heading;\n  return true;\n}\n\nfunction applyCargoPickup(world, prediction) {\n  const player = world?.players?.[prediction.playerIndex];\n  const crate = crateById(world, prediction.crateId);\n  if (!player?.combat || !crate || crate.state !== "world") return false;\n  crate.state = "carried";\n  crate.carriedBy = prediction.playerIndex;\n  crate.stowedBoat = null;\n  crate.x = player.x;\n  crate.y = player.y;\n  player.combat.carriedCrate = crate.id;\n  return true;\n}\n\nfunction applyCargoStow(world, prediction) {\n  const player = world?.players?.[prediction.playerIndex];\n  const crate = crateById(world, prediction.crateId);\n  const boat = world?.boats?.find(candidate => candidate?.id === prediction.boatId);\n  if (!player?.combat || !crate || !canStow(world, boat, crate)) return false;\n  boat.cargo ||= [];\n  if (!boat.cargo.includes(crate.id)) boat.cargo.push(crate.id);\n  crate.state = "stowed";\n  crate.carriedBy = null;\n  crate.stowedBoat = boat.id;\n  crate.x = boat.x;\n  crate.y = boat.y;\n  player.combat.carriedCrate = null;\n  return true;\n}\n\nfunction applyCargoDrop(world, prediction) {\n  const player = world?.players?.[prediction.playerIndex];\n  const crate = crateById(world, prediction.crateId);\n  if (!player?.combat || !crate) return false;\n  crate.state = "world";\n  crate.carriedBy = null;\n  crate.stowedBoat = null;\n  crate.x = Number(player.x) || 210;\n  crate.y = Number(player.y) || 62;\n  player.combat.carriedCrate = null;\n  return true;\n}\n\nexport function applyLocalActionPrediction(world, prediction, nowMs = performance.now()) {\n  if (!world || !prediction) return false;\n  switch (prediction.type) {\n    case "jump": return applyJump(world, prediction, nowMs);\n    case "roof-climb": return applyRoofClimb(world, prediction);\n    case "roof-dismount": return applyRoofDismount(world, prediction);\n    case "brake": return applyBrake(world, prediction);\n    case "cargo-pickup": return applyCargoPickup(world, prediction);\n    case "cargo-stow": return applyCargoStow(world, prediction);\n    case "cargo-drop": return applyCargoDrop(world, prediction);\n    default: return false;\n  }\n}\n\nexport function localActionPredictionExpired(prediction, nowMs = performance.now()) {\n  const age = Math.max(0, Number(nowMs) - Number(prediction?.startedAtMs));\n  return age > Math.max(250, Number(prediction?.expiryMs) || 1_500);\n}\n'
LOCAL_ACTION_TEST = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport {\n  applyLocalActionPrediction,\n  createLocalActionPrediction,\n  localActionPredictionExpired,\n} from "../public/src/free-roam-local-actions.js";\n\nfunction worldFixture() {\n  return {\n    time: 10,\n    players: [\n      {\n        id: 0,\n        mode: "foot",\n        activeBoat: null,\n        x: 100,\n        y: 100,\n        heading: 0,\n        airborne: false,\n        jumpHeight: 0,\n        combat: {alive: true, knockedDown: false, carriedCrate: null},\n      },\n      {\n        id: 1,\n        mode: "foot",\n        activeBoat: null,\n        x: 200,\n        y: 200,\n        heading: 0,\n        combat: {alive: true, knockedDown: false, carriedCrate: null},\n      },\n    ],\n    boats: [\n      {\n        id: 0,\n        owner: 0,\n        driver: 0,\n        x: 160,\n        y: 160,\n        heading: 0,\n        speed: 8,\n        throttle: 1,\n        rudder: 0.4,\n        floatingBrakeReadyAt: 0,\n        cargo: [],\n        sunk: false,\n      },\n    ],\n    freeActivities: {\n      presence: [true, false],\n      crates: [\n        {\n          id: "crate-test",\n          kind: "valuable",\n          label: "тестовый ящик",\n          slots: 1,\n          state: "world",\n          carriedBy: null,\n          stowedBoat: null,\n          x: 102,\n          y: 100,\n        },\n      ],\n    },\n  };\n}\n\ntest("local foot jump starts immediately and follows the local arc", () => {\n  const world = worldFixture();\n  const prediction = createLocalActionPrediction(world, 0, "jump", 1_000);\n  assert.equal(prediction.type, "jump");\n  assert.equal(applyLocalActionPrediction(world, prediction, 1_000), true);\n  assert.equal(world.players[0].airborne, true);\n  assert.ok(world.players[0].jumpHeight >= 0.04);\n  applyLocalActionPrediction(world, prediction, 1_900);\n  assert.equal(world.players[0].airborne, false);\n  assert.equal(world.players[0].jumpHeight, 0);\n});\n\ntest("local floating brake cuts rendered boat speed without waiting for the server", () => {\n  const world = worldFixture();\n  world.players[0].mode = "boat";\n  world.players[0].activeBoat = 0;\n  const prediction = createLocalActionPrediction(world, 0, "jump", 2_000);\n  assert.equal(prediction.type, "brake");\n  assert.equal(applyLocalActionPrediction(world, prediction, 2_000), true);\n  assert.ok(Math.abs(world.boats[0].speed) <= 0.12);\n  assert.equal(world.boats[0].throttle, 0);\n  assert.equal(world.boats[0].rudder, 0);\n  assert.equal(world.boats[0].floatingBrakeReadyAt, 22);\n});\n\ntest("nearby cargo is picked up and then stowed locally", () => {\n  const world = worldFixture();\n  const pickup = createLocalActionPrediction(world, 0, "action", 3_000);\n  assert.equal(pickup.type, "cargo-pickup");\n  assert.equal(applyLocalActionPrediction(world, pickup, 3_000), true);\n  assert.equal(world.players[0].combat.carriedCrate, "crate-test");\n  assert.equal(world.freeActivities.crates[0].state, "carried");\n\n  world.players[0].x = 160;\n  world.players[0].y = 168;\n  const stow = createLocalActionPrediction(world, 0, "action", 3_100);\n  assert.equal(stow.type, "cargo-stow");\n  assert.equal(applyLocalActionPrediction(world, stow, 3_100), true);\n  assert.equal(world.players[0].combat.carriedCrate, null);\n  assert.deepEqual(world.boats[0].cargo, ["crate-test"]);\n  assert.equal(world.freeActivities.crates[0].state, "stowed");\n});\n\ntest("prediction expiry prevents stale optimistic actions surviving reconnects", () => {\n  const prediction = {startedAtMs: 1_000, expiryMs: 1_500};\n  assert.equal(localActionPredictionExpired(prediction, 2_400), false);\n  assert.equal(localActionPredictionExpired(prediction, 2_501), true);\n});\n'

def replace_once(path, old, new):
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one occurrence in {path} but found {count}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")

def replace_all(path, old, new):
    text = path.read_text(encoding="utf-8")
    if old not in text:
        return False
    path.write_text(text.replace(old, new), encoding="utf-8")
    return True

(ROOT / "public/src/free-roam-local-actions.js").write_text(LOCAL_ACTIONS, encoding="utf-8")
(ROOT / "tests/free-roam-local-actions.test.mjs").write_text(LOCAL_ACTION_TEST, encoding="utf-8")

client = ROOT / "public/src/free-roam-v4.js"
replace_once(
    client,
    '} from "./free-roam-client-prediction.js?v=42";\n',
    '} from "./free-roam-client-prediction.js?v=42";\n'
    'import {\n'
    '  applyLocalActionPrediction,\n'
    '  createLocalActionPrediction,\n'
    '  localActionPredictionExpired,\n'
    '} from "./free-roam-local-actions.js?v=1";\n',
)
replace_once(
    client,
    'let messageVersion = 0;\n',
    'let messageVersion = 0;\n'
    'let pendingActionPredictions = [];\n'
    'const localAnnouncementSuppressUntil = new Map();\n',
)
replace_once(
    client,
    '      authoritativeWorld = null;\n      inputSentAt.clear();\n',
    '      authoritativeWorld = null;\n'
    '      inputSentAt.clear();\n'
    '      pendingActionPredictions = [];\n'
    '      localAnnouncementSuppressUntil.clear();\n',
)
replace_once(
    client,
    '''      authoritativeWorld = nextAuthoritative;
      const previousWorld = world;
      const renderWorld = typeof structuredClone === "function"
        ? structuredClone(authoritativeWorld)
        : JSON.parse(JSON.stringify(authoritativeWorld));
      const predictionLead = localPredictionLeadSeconds({networkRttMs, inputReceiptMs, controlLatencyMs});
      predictLocalWorldAhead(renderWorld, playerIndex, localInput, predictionLead);
      world = reconcileLocalPrediction(previousWorld, renderWorld, playerIndex, {
        input: localInput,
        networkRttMs,
      });
      lastStateSequence = sequence;
      lastStateAt = performance.now();
''',
    '''      authoritativeWorld = nextAuthoritative;
      const previousWorld = world;
      const acknowledged = Math.max(0, Number(message.ackInput) || 0);
      const receivedAt = performance.now();
      pendingActionPredictions = pendingActionPredictions.filter(prediction => (
        prediction.sequence > acknowledged && !localActionPredictionExpired(prediction, receivedAt)
      ));
      const renderWorld = typeof structuredClone === "function"
        ? structuredClone(authoritativeWorld)
        : JSON.parse(JSON.stringify(authoritativeWorld));
      for (const prediction of pendingActionPredictions) {
        applyLocalActionPrediction(renderWorld, prediction, receivedAt);
      }
      const predictionLead = localPredictionLeadSeconds({networkRttMs, inputReceiptMs, controlLatencyMs});
      predictLocalWorldAhead(renderWorld, playerIndex, localInput, predictionLead);
      world = reconcileLocalPrediction(previousWorld, renderWorld, playerIndex, {
        input: localInput,
        networkRttMs,
      });
      lastStateSequence = sequence;
      lastStateAt = receivedAt;
''',
)
replace_once(
    client,
    '      const acknowledged = Math.max(0, Number(message.ackInput) || 0);\n'
    '      const sentAt = inputSentAt.get(acknowledged);\n',
    '      const sentAt = inputSentAt.get(acknowledged);\n',
)
replace_once(
    client,
    '''function sendInput(force = false) {
  const serialized = JSON.stringify(localInput);
  if (!force && serialized === lastInputSent) return;
  lastInputSent = serialized;
  const sequence = ++inputSequence;
  inputSentAt.set(sequence, performance.now());
  while (inputSentAt.size > 48) inputSentAt.delete(inputSentAt.keys().next().value);
  send({type: "free-input", sequence, input: localInput});
}
''',
    '''function sendInput(force = false) {
  const serialized = JSON.stringify(localInput);
  if (!force && serialized === lastInputSent) return 0;
  lastInputSent = serialized;
  const sequence = ++inputSequence;
  inputSentAt.set(sequence, performance.now());
  while (inputSentAt.size > 48) inputSentAt.delete(inputSentAt.keys().next().value);
  send({type: "free-input", sequence, input: localInput});
  return sequence;
}
''',
)
replace_once(
    client,
    '''  localInput[name] = Boolean(active);
  sendInput(true);
  syncControlButtons();
  return true;
}
''',
    '''  localInput[name] = Boolean(active);
  const sequence = sendInput(true);
  syncControlButtons();
  return sequence || true;
}
''',
)
replace_once(
    client,
    '''function actionPulse(name, duration = 140) {
  setControl(name, true);
  clearTimeout(holdTimers.get(name));
  holdTimers.set(name, setTimeout(() => setControl(name, false), duration));
}
''',
    '''function actionPulse(name, duration = 140) {
  const startedAt = performance.now();
  const prediction = !localInput[name]
    ? createLocalActionPrediction(world, playerIndex, name, startedAt)
    : null;
  const sequence = setControl(name, true);
  if (prediction && sequence) {
    prediction.sequence = Number(sequence) || inputSequence;
    pendingActionPredictions.push(prediction);
    while (pendingActionPredictions.length > 12) pendingActionPredictions.shift();
    applyLocalActionPrediction(world, prediction, startedAt);
    audio.playLocalActionCue?.(prediction.cue, prediction.suppressEvents);
    for (const eventType of prediction.suppressEvents || []) {
      localAnnouncementSuppressUntil.set(eventType, startedAt + 2_000);
    }
    if (prediction.announcement) announce(prediction.announcement);
    render();
  }
  clearTimeout(holdTimers.get(name));
  holdTimers.set(name, setTimeout(() => setControl(name, false), duration));
}
''',
)
replace_once(
    client,
    '''  if (["hull-repair-complete", "repair-blocked"].includes(event.type)) setControl("repair", false);
  if (!event.text) return;
''',
    '''  if (["hull-repair-complete", "repair-blocked"].includes(event.type)) setControl("repair", false);
  const suppressUntil = localAnnouncementSuppressUntil.get(event.type) || 0;
  const localSource = event.sourcePlayer == null || event.sourcePlayer === playerIndex;
  if (event.text && localSource && performance.now() <= suppressUntil) {
    localAnnouncementSuppressUntil.delete(event.type);
    return;
  }
  if (!event.text) return;
''',
)
replace_once(
    client,
    '''    } else if (!event.repeat && event.code === "Space") {
      event.preventDefault();
      audio.playLocalCommandCue?.(world?.players?.[playerIndex]?.mode === "boat" ? "brake" : "jump");
      actionPulse("jump");
''',
    '''    } else if (!event.repeat && event.code === "Space") {
      event.preventDefault();
      actionPulse("jump");
''',
)
replace_once(
    client,
    '''$("jumpButton").addEventListener("click", () => {
  audio.playLocalCommandCue?.(world?.players?.[playerIndex]?.mode === "boat" ? "brake" : "jump");
  actionPulse("jump");
});
''',
    '''$("jumpButton").addEventListener("click", () => {
  actionPulse("jump");
});
''',
)
replace_once(
    client,
    '''  localFeedback: () => {
    if (world) audio.updateLocalFeedback?.(world, playerIndex, localInput);
  },
''',
    '''  localFeedback: () => {
    if (world) audio.updateLocalFeedback?.(world, playerIndex, localInput);
  },
  localActionDiagnostics: () => pendingActionPredictions.map(prediction => ({
    type: prediction.type,
    sequence: prediction.sequence,
    ageMs: Math.max(0, performance.now() - prediction.startedAtMs),
  })),
''',
)

audio = ROOT / "public/src/free-roam-audio-v5.js"
replace_once(
    audio,
    '    this.localFireSuppressUntil = 0;\n',
    '    this.localFireSuppressUntil = 0;\n'
    '    this.localActionSuppressUntil = new Map();\n',
)
replace_once(
    audio,
    '''  playLocalCommandCue(kind = "action") {
    if (!this.ctx) return false;
    const frequency = kind === "sonar" ? 610 : kind === "brake" ? 190 : 340;
    this.playSynthPip({frequency, gain: 0.035, duration: 0.045});
    return true;
  }
''',
    '''  playLocalCommandCue(kind = "action") {
    if (!this.ctx) return false;
    const frequency = kind === "sonar" ? 610 : kind === "brake" ? 190 : 340;
    this.playSynthPip({frequency, gain: 0.035, duration: 0.045});
    return true;
  }

  playLocalActionCue(kind = "action", suppressEvents = []) {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    for (const eventType of suppressEvents || []) {
      this.localActionSuppressUntil.set(eventType, now + 2);
    }
    if (kind === "jump" || kind === "roof") {
      this.playFootstep({gain: 0.28, rate: kind === "roof" ? 1.08 : 1.02});
      if (this.buffers.has("hullCreak")) {
        this.play("hullCreak", {gain: kind === "roof" ? 0.17 : 0.09, rate: 1.05, lowpass: 5200});
      }
      return true;
    }
    if (kind === "brake") {
      this.playSynthPip({frequency: 190, gain: 0.065, duration: 0.07});
      if (this.buffers.has("hullCreak")) this.play("hullCreak", {gain: 0.16, rate: 0.76, lowpass: 3200});
      return true;
    }
    if (["cargo-pickup", "cargo-stow", "cargo-drop"].includes(kind)) {
      if (this.buffers.has("repair")) {
        const rate = kind === "cargo-stow" ? 0.86 : kind === "cargo-drop" ? 0.78 : 1.08;
        this.play("repair", {gain: 0.27, rate, lowpass: 5200});
      } else {
        this.playSynthPip({frequency: kind === "cargo-pickup" ? 540 : 330, gain: 0.055, duration: 0.07});
      }
      return true;
    }
    if (kind === "deny") {
      this.handle([{type: "ui-deny"}]);
      return true;
    }
    return this.playLocalCommandCue(kind);
  }
''',
)
replace_once(
    audio,
    '''    const localNow = this.ctx?.currentTime || 0;
    if (
      event.sourcePlayer === playerIndex
''',
    '''    const localNow = this.ctx?.currentTime || 0;
    const localActionUntil = this.localActionSuppressUntil.get(event.type) || 0;
    const localActionSource = event.sourcePlayer == null || event.sourcePlayer === playerIndex;
    if (localActionSource && localNow <= localActionUntil) {
      this.localActionSuppressUntil.delete(event.type);
      return;
    }
    if (
      event.sourcePlayer === playerIndex
''',
)

for path in [
    ROOT / "public/src/free-roam-v4.js",
    ROOT / "public/src/free-roam-quality-v1.js",
    ROOT / "public/src/free-roam-pistol-audio.js",
]:
    if not replace_all(path, 'free-roam-audio-v5.js?v=44', 'free-roam-audio-v5.js?v=45'):
        raise SystemExit(f"Audio import version not found in {path}")

html = ROOT / "public/free-roam.html"
replace_once(html, 'free-roam-v4.js?v=53', 'free-roam-v4.js?v=54')

for path in (ROOT / "tests").glob("*.mjs"):
    replace_all(path, r'free-roam-audio-v5\.js\?v=44', r'free-roam-audio-v5\.js\?v=45')
    replace_all(path, r'free-roam-v4\.js\?v=53', r'free-roam-v4\.js\?v=54')
