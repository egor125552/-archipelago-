import {writeFile} from "node:fs/promises";
import {webkit} from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});

await page.addInitScript(() => {
  globalThis.__jitterEvents = [];
  const nativeAdd = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function(type, listener, options) {
    if (type !== "message" || typeof listener !== "function") return nativeAdd.call(this, type, listener, options);
    const wrapped = function(event) {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === "free-state") {
          globalThis.__lastFreeState = {at: performance.now(), sequence: message.sequence, ackInput: message.ackInput, serverAt: message.serverAt};
          for (const item of message.events || []) globalThis.__jitterEvents.push({type: item?.type, sourcePlayer: item?.sourcePlayer, at: performance.now()});
        }
      } catch (_) {}
      return listener.call(this, event);
    };
    return nativeAdd.call(this, type, wrapped, options);
  };
});

async function beginSamples(name, durationMs) {
  await page.evaluate(({name, durationMs}) => {
    globalThis[name] = [];
    const stopAt = performance.now() + durationMs;
    const sample = now => {
      const player = globalThis.__freeRoam?.getWorld?.()?.players?.[0];
      const boat = globalThis.__freeRoam?.getWorld?.()?.boats?.[0];
      if (player) globalThis[name].push({
        at: now,
        x: player.x,
        y: player.y,
        mode: player.mode,
        boatX: boat?.x,
        boatY: boat?.y,
        inputUp: Boolean(globalThis.__freeRoam?.input?.up),
        inputDown: Boolean(globalThis.__freeRoam?.input?.down),
        state: globalThis.__lastFreeState || null,
      });
      if (now < stopAt) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, {name, durationMs});
}

await page.goto("http://127.0.0.1:8788/free-roam.html", {waitUntil: "domcontentloaded"});
await page.click("#hostButton");
await page.waitForFunction(() => !document.querySelector("#game")?.hidden && globalThis.__freeRoam?.getWorld?.(), null, {timeout: 20_000});
await page.waitForTimeout(1800);
await page.keyboard.press("KeyF");
await page.waitForFunction(() => globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.mode === "swim", null, {timeout: 8_000});
await page.waitForTimeout(1200);

await beginSamples("__collisionSamples", 2400);
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(1900);
await page.keyboard.up("ArrowUp");
await page.waitForTimeout(600);

const collision = await page.evaluate(() => {
  const samples = globalThis.__collisionSamples || [];
  const expectedMinimumY = samples.length ? (Number(samples[0].boatY) || 0) + 7.4 : 0;
  const minimumY = samples.length ? Math.min(...samples.map(item => item.y)) : 0;
  const corrections = [];
  for (let index = 1; index < samples.length; index += 1) {
    const deltaY = samples[index].y - samples[index - 1].y;
    if (deltaY > 0.015) corrections.push(deltaY);
  }
  return {
    sampleCount: samples.length,
    expectedMinimumY,
    minimumY,
    hullPenetration: Math.max(0, expectedMinimumY - minimumY),
    backwardsCount: corrections.length,
    maxBackwards: corrections.length ? Math.max(...corrections) : 0,
    finalY: samples.at(-1)?.y,
  };
});

await page.waitForTimeout(500);
await beginSamples("__openWaterSamples", 5400);
await page.keyboard.down("ArrowDown");
await page.waitForTimeout(5000);
await page.keyboard.up("ArrowDown");
await page.waitForTimeout(600);

const openWater = await page.evaluate(() => {
  const samples = globalThis.__openWaterSamples || [];
  const backwards = [];
  const forward = [];
  for (let index = 1; index < samples.length; index += 1) {
    const deltaY = samples[index].y - samples[index - 1].y;
    if (deltaY < -0.015) backwards.push(-deltaY);
    if (deltaY > 0.001) forward.push(deltaY);
  }
  const steps = (globalThis.__jitterEvents || []).filter(event => event.type === "swim-step" && event.sourcePlayer === 0);
  return {
    sampleCount: samples.length,
    startY: samples[0]?.y,
    finalY: samples.at(-1)?.y,
    distance: (samples.at(-1)?.y || 0) - (samples[0]?.y || 0),
    backwardsCount: backwards.length,
    largeBackwardsCount: backwards.filter(value => value > 0.08).length,
    maxBackwards: backwards.length ? Math.max(...backwards) : 0,
    maximumForwardFrame: forward.length ? Math.max(...forward) : 0,
    stepCount: steps.length,
    stepIntervals: steps.slice(1).map((event, index) => event.at - steps[index].at),
    network: globalThis.__freeRoam?.networkDiagnostics?.(),
  };
});

const result = {collision, openWater};
await writeFile("desktop-jitter-result.json", JSON.stringify(result, null, 2));
console.log("DESKTOP_JITTER_AUDIT " + JSON.stringify(result));
await browser.close();
