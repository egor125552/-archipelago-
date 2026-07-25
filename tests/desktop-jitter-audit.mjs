import {writeFile} from "node:fs/promises";
import {webkit} from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});

await page.addInitScript(() => {
  globalThis.__jitterEvents = [];
  globalThis.__keyReleasedAt = null;
  const nativeAdd = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function(type, listener, options) {
    if (type !== "message" || typeof listener !== "function") return nativeAdd.call(this, type, listener, options);
    const wrapped = function(event) {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === "free-state") {
          globalThis.__lastFreeState = {
            at: performance.now(),
            sequence: message.sequence,
            ackInput: message.ackInput,
            serverAt: message.serverAt,
          };
          for (const item of message.events || []) {
            globalThis.__jitterEvents.push({type: item?.type, sourcePlayer: item?.sourcePlayer, at: performance.now()});
          }
        }
      } catch (_) {}
      return listener.call(this, event);
    };
    return nativeAdd.call(this, type, wrapped, options);
  };
});

await page.goto("http://127.0.0.1:8788/free-roam.html", {waitUntil: "domcontentloaded"});
await page.click("#hostButton");
await page.waitForFunction(() => !document.querySelector("#game")?.hidden && globalThis.__freeRoam?.getWorld?.(), null, {timeout: 20_000});
await page.waitForTimeout(1800);
await page.keyboard.press("KeyF");
await page.waitForFunction(() => ["foot", "swim"].includes(globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.mode), null, {timeout: 8_000});
await page.waitForTimeout(1200);

await page.evaluate(() => {
  globalThis.__movementSamples = [];
  const stopAt = performance.now() + 5400;
  const sample = now => {
    const player = globalThis.__freeRoam?.getWorld?.()?.players?.[0];
    if (player) {
      globalThis.__movementSamples.push({
        at: now,
        x: player.x,
        y: player.y,
        mode: player.mode,
        health: player.combat?.health,
        alive: player.combat?.alive,
        knockedDown: player.combat?.knockedDown,
        inputUp: Boolean(globalThis.__freeRoam?.input?.up),
        state: globalThis.__lastFreeState || null,
      });
    }
    if (now < stopAt) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(5000);
await page.evaluate(() => { globalThis.__keyReleasedAt = performance.now(); });
await page.keyboard.up("ArrowUp");
await page.waitForTimeout(700);

const movement = await page.evaluate(() => {
  const samples = globalThis.__movementSamples || [];
  const transitions = [];
  for (let index = 1; index < samples.length; index += 1) {
    const deltaY = samples[index].y - samples[index - 1].y;
    if (deltaY > 0.015) transitions.push({
      index,
      deltaY,
      sinceReleaseMs: globalThis.__keyReleasedAt == null ? null : samples[index].at - globalThis.__keyReleasedAt,
      previous: samples[index - 1],
      next: samples[index],
    });
  }
  const steps = (globalThis.__jitterEvents || []).filter(event => ["footstep", "swim-step"].includes(event.type) && event.sourcePlayer === 0);
  return {
    mode: globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.mode,
    sampleCount: samples.length,
    backwardsCount: transitions.length,
    largeBackwardsCount: transitions.filter(item => item.deltaY > 0.08).length,
    maxBackwards: transitions.length ? Math.max(...transitions.map(item => item.deltaY)) : 0,
    backwardsTransitions: transitions.slice(-8),
    stepCount: steps.length,
    stepIntervals: steps.slice(1).map((event, index) => event.at - steps[index].at),
    network: globalThis.__freeRoam?.networkDiagnostics?.(),
  };
});

const result = {movement};
await writeFile("desktop-jitter-result.json", JSON.stringify(result, null, 2));
console.log("DESKTOP_JITTER_AUDIT " + JSON.stringify(result));
await browser.close();
