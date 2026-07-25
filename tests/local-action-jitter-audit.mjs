import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {webkit} from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});

await page.addInitScript(() => {
  globalThis.__localActionAudit = {
    inputs: [],
    receipts: [],
    acknowledgements: [],
    frames: [],
    cues: [],
    labels: [],
  };

  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    try {
      const message = JSON.parse(String(data));
      if (message?.type === "free-input") {
        globalThis.__localActionAudit.inputs.push({
          at: performance.now(),
          sequence: Number(message.sequence) || 0,
          input: {...message.input},
        });
      }
    } catch (_) {}
    return nativeSend.call(this, data);
  };

  const nativeAdd = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function(type, listener, options) {
    if (type !== "message" || typeof listener !== "function") {
      return nativeAdd.call(this, type, listener, options);
    }
    const wrapped = function(event) {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === "free-input-received") {
          globalThis.__localActionAudit.receipts.push({
            at: performance.now(),
            sequence: Number(message.sequence) || 0,
          });
        } else if (message?.type === "free-state") {
          const ack = Array.isArray(message.ackInput)
            ? Math.max(0, Number(message.ackInput[0]) || 0)
            : Math.max(0, Number(message.ackInput) || 0);
          globalThis.__localActionAudit.acknowledgements.push({
            at: performance.now(),
            ack,
          });
        }
      } catch (_) {}
      return listener.call(this, event);
    };
    return nativeAdd.call(this, type, wrapped, options);
  };

  const capture = now => {
    const api = globalThis.__freeRoam;
    const world = api?.getWorld?.();
    const player = world?.players?.[0];
    const boat = world?.boats?.[0];
    if (player && boat) {
      globalThis.__localActionAudit.frames.push({
        at: now,
        mode: player.mode,
        airborne: Boolean(player.airborne),
        jumpHeight: Number(player.jumpHeight) || 0,
        x: Number(player.x) || 0,
        y: Number(player.y) || 0,
        speed: Number(boat.speed) || 0,
        boatY: Number(boat.y) || 0,
        carried: player.combat?.carriedCrate || null,
        boatCargo: [...(boat.cargo || [])],
        pending: api.localActionDiagnostics?.() || [],
      });
    }
    requestAnimationFrame(capture);
  };
  requestAnimationFrame(capture);
});

await page.goto("http://127.0.0.1:8788/free-roam.html", {waitUntil: "domcontentloaded"});
await page.evaluate(async () => {
  const {FreeRoamAudio} = await import("/src/free-roam-audio-v5.js?v=45");
  if (FreeRoamAudio.prototype.__localActionAuditWrapped) return;
  const original = FreeRoamAudio.prototype.playLocalActionCue;
  FreeRoamAudio.prototype.playLocalActionCue = function(kind, suppressEvents) {
    globalThis.__localActionAudit.cues.push({
      at: performance.now(),
      kind,
      suppressEvents: [...(suppressEvents || [])],
    });
    return original.call(this, kind, suppressEvents);
  };
  FreeRoamAudio.prototype.__localActionAuditWrapped = true;
});

await page.click("#hostButton");
await page.waitForFunction(() => (
  !document.querySelector("#game")?.hidden
  && globalThis.__freeRoam?.getWorld?.()
  && (globalThis.__freeRoam?.networkDiagnostics?.()?.networkRttMs || 0) >= 150
), null, {timeout: 30_000});
await page.waitForTimeout(800);

async function mark(label) {
  await page.evaluate(value => {
    globalThis.__localActionAudit.labels.push({label: value, at: performance.now()});
  }, label);
}

async function waitPendingEmpty() {
  await page.waitForFunction(() => (globalThis.__freeRoam?.localActionDiagnostics?.() || []).length === 0, null, {timeout: 8_000});
  await page.waitForTimeout(250);
}

// 1. The audit fixture puts crate-pump directly beside the captain's boat.
await mark("cargo-stow");
await page.keyboard.press("KeyF");
await page.waitForFunction(() => globalThis.__freeRoam?.getWorld?.()?.boats?.[0]?.cargo?.includes("crate-pump"), null, {timeout: 2_000});
await waitPendingEmpty();
assert.ok(await page.evaluate(() => globalThis.__freeRoam.getWorld().boats[0].cargo.includes("crate-pump")));

// 2. Drive toward the shore and engage the floating brake while moving.
await page.keyboard.down("ArrowUp");
await page.waitForFunction(() => {
  const boat = globalThis.__freeRoam?.getWorld?.()?.boats?.[0];
  return boat && boat.y <= 86 && Math.abs(boat.speed) >= 2;
}, null, {timeout: 12_000});
await mark("brake");
await page.keyboard.press("Space");
await page.waitForFunction(() => Math.abs(globalThis.__freeRoam?.getWorld?.()?.boats?.[0]?.speed || 0) <= 0.13, null, {timeout: 2_000});
await page.keyboard.up("ArrowUp");
await waitPendingEmpty();
await page.waitForFunction(() => {
  const boat = globalThis.__freeRoam?.getWorld?.()?.boats?.[0];
  return boat && boat.y <= 90 && Math.abs(boat.speed) <= 0.3;
}, null, {timeout: 8_000});

// Exit onto the shore authoritatively, then walk away from the boat toward crate-plates.
await page.keyboard.press("KeyF");
await page.waitForFunction(() => globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.mode === "foot", null, {timeout: 8_000});
await page.keyboard.down("ArrowUp");
await page.keyboard.down("ArrowLeft");
await page.waitForTimeout(3_500);
await page.keyboard.up("ArrowLeft");
await page.keyboard.up("ArrowUp");
await page.waitForFunction(() => {
  const world = globalThis.__freeRoam?.getWorld?.();
  const player = world?.players?.[0];
  const crate = world?.freeActivities?.crates?.find(item => item.id === "crate-plates");
  return player && crate && Math.hypot(player.x - crate.x, player.y - crate.y) <= 12;
}, null, {timeout: 5_000});

// 3. Ordinary foot jump: body arc and cue must start before the server receipt.
await mark("jump");
await page.keyboard.press("Space");
await page.waitForFunction(() => globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.airborne === true, null, {timeout: 2_000});
await waitPendingEmpty();
await page.waitForFunction(() => !globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.airborne, null, {timeout: 3_000});

// 4. Pick up the shore crate, confirm it survives acknowledgement, then drop it.
await mark("cargo-pickup");
await page.keyboard.press("KeyF");
await page.waitForFunction(() => globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.combat?.carriedCrate === "crate-plates", null, {timeout: 2_000});
await waitPendingEmpty();
assert.equal(await page.evaluate(() => globalThis.__freeRoam.getWorld().players[0].combat.carriedCrate), "crate-plates");

await mark("cargo-drop");
await page.keyboard.press("KeyF");
await page.waitForFunction(() => globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.combat?.carriedCrate == null, null, {timeout: 2_000});
await waitPendingEmpty();
assert.equal(await page.evaluate(() => globalThis.__freeRoam.getWorld().players[0].combat.carriedCrate), null);

const result = await page.evaluate(() => {
  const audit = globalThis.__localActionAudit;
  const rules = {
    "cargo-stow": {
      key: "action",
      cue: "cargo-stow",
      state: frame => frame.boatCargo.includes("crate-pump"),
    },
    brake: {
      key: "jump",
      cue: "brake",
      state: frame => Math.abs(frame.speed) <= 0.13,
    },
    jump: {
      key: "jump",
      cue: "jump",
      state: frame => frame.airborne && frame.jumpHeight > 0,
    },
    "cargo-pickup": {
      key: "action",
      cue: "cargo-pickup",
      state: frame => frame.carried === "crate-plates",
    },
    "cargo-drop": {
      key: "action",
      cue: "cargo-drop",
      state: frame => frame.carried == null,
    },
  };

  const metrics = {};
  for (const label of audit.labels) {
    const rule = rules[label.label];
    if (!rule) continue;
    const input = audit.inputs.find(item => item.at >= label.at && item.input?.[rule.key]);
    const receipt = input && audit.receipts.find(item => item.sequence === input.sequence);
    const acknowledgement = input && audit.acknowledgements.find(item => item.ack >= input.sequence);
    const cue = audit.cues.find(item => item.at >= label.at && item.kind === rule.cue);
    const state = audit.frames.find(frame => frame.at >= label.at && rule.state(frame));
    const rollbackFrames = state && acknowledgement
      ? audit.frames.filter(frame => frame.at > state.at && frame.at < acknowledgement.at && !rule.state(frame)).length
      : 0;
    metrics[label.label] = {
      labelAt: label.at,
      inputSequence: input?.sequence || null,
      inputSendDelayMs: input ? input.at - label.at : null,
      localStateDelayMs: state ? state.at - label.at : null,
      localCueDelayMs: cue ? cue.at - label.at : null,
      serverReceiptDelayMs: receipt ? receipt.at - label.at : null,
      serverAckDelayMs: acknowledgement ? acknowledgement.at - label.at : null,
      rollbackFramesBeforeAck: rollbackFrames,
    };
  }
  return {
    network: globalThis.__freeRoam.networkDiagnostics(),
    metrics,
    final: audit.frames.at(-1),
  };
});

for (const [name, metric] of Object.entries(result.metrics)) {
  assert.ok(metric.inputSequence, `${name}: no input sequence captured`);
  assert.ok(metric.localStateDelayMs != null && metric.localStateDelayMs <= 80, `${name}: local state delay ${metric.localStateDelayMs}`);
  assert.ok(metric.localCueDelayMs != null && metric.localCueDelayMs <= 80, `${name}: local cue delay ${metric.localCueDelayMs}`);
  assert.ok(metric.serverReceiptDelayMs != null && metric.serverReceiptDelayMs >= 130, `${name}: server receipt delay ${metric.serverReceiptDelayMs}`);
  assert.equal(metric.rollbackFramesBeforeAck, 0, `${name}: optimistic state rolled back before acknowledgement`);
}

assert.ok(result.network.networkRttMs >= 150, `RTT too low for audit: ${result.network.networkRttMs}`);
await writeFile("local-action-jitter-result.json", JSON.stringify(result, null, 2));
console.log("LOCAL_ACTION_JITTER_AUDIT " + JSON.stringify(result));
await browser.close();
