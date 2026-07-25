import {writeFile} from "node:fs/promises";
import {webkit} from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});

await page.goto("http://127.0.0.1:8788/free-roam.html", {waitUntil: "domcontentloaded"});
await page.click("#hostButton");
await page.waitForFunction(() => !document.querySelector("#game")?.hidden && globalThis.__freeRoam?.getWorld?.(), null, {timeout: 25_000});
await page.waitForFunction(() => globalThis.__freeRoamSharpAudio?.ctx, null, {timeout: 25_000});
await page.waitForTimeout(1000);

await page.evaluate(() => {
  const audio = globalThis.__freeRoamSharpAudio;
  globalThis.__sharpAudit = {actions: [], buffers: [], clicks: []};
  const originalAction = audio.playImmediateAction.bind(audio);
  audio.playImmediateAction = (kind, details) => {
    globalThis.__sharpAudit.actions.push({kind, at: performance.now(), details});
    return originalAction(kind, details);
  };
  const originalBuffer = audio.playSharpBuffer.bind(audio);
  audio.playSharpBuffer = (name, options) => {
    globalThis.__sharpAudit.buffers.push({name, at: performance.now(), options});
    return originalBuffer(name, options);
  };
  const originalClick = audio.playSharpClick.bind(audio);
  audio.playSharpClick = options => {
    globalThis.__sharpAudit.clicks.push({at: performance.now(), options});
    return originalClick(options);
  };
});

async function measureKey(code, expectedKind, setup = null) {
  if (setup) await page.evaluate(setup);
  const before = await page.evaluate(() => performance.now());
  await page.keyboard.press(code);
  await page.waitForFunction(kind => globalThis.__sharpAudit.actions.some(item => item.kind === kind && item.at >= globalThis.__auditBefore), expectedKind, {timeout: 2_000}).catch(() => {});
  const result = await page.evaluate(({expectedKind, before}) => {
    globalThis.__auditBefore = before;
    const match = globalThis.__sharpAudit.actions.find(item => item.kind === expectedKind && item.at >= before);
    return {before, at: match?.at ?? null, delayMs: match ? match.at - before : null};
  }, {expectedKind, before});
  return result;
}

// Exit the boat first so Space is a person jump rather than the floating brake.
await page.keyboard.press("KeyF");
await page.waitForFunction(() => ["foot", "swim"].includes(globalThis.__freeRoam?.getWorld?.()?.players?.[0]?.mode), null, {timeout: 10_000});
await page.waitForTimeout(500);

const jumpBefore = await page.evaluate(() => performance.now());
await page.keyboard.press("Space");
await page.waitForFunction(before => globalThis.__sharpAudit.actions.some(item => item.kind === "jump" && item.at >= before), jumpBefore, {timeout: 2_000});
const jump = await page.evaluate(before => {
  const match = globalThis.__sharpAudit.actions.find(item => item.kind === "jump" && item.at >= before);
  return {before, at: match?.at ?? null, delayMs: match ? match.at - before : null};
}, jumpBefore);

const attackBefore = await page.evaluate(() => performance.now());
await page.keyboard.press("KeyX");
await page.waitForFunction(before => globalThis.__sharpAudit.actions.some(item => item.kind === "attack" && item.at >= before), attackBefore, {timeout: 2_000});
const attack = await page.evaluate(before => {
  const match = globalThis.__sharpAudit.actions.find(item => item.kind === "attack" && item.at >= before);
  return {before, at: match?.at ?? null, delayMs: match ? match.at - before : null, weapon: match?.details?.weapon};
}, attackBefore);

await page.evaluate(() => {
  const player = globalThis.__freeRoam.getWorld().players[0];
  player.combat.carriedCrate = "audit-cargo";
});
const cargoBefore = await page.evaluate(() => performance.now());
await page.keyboard.press("KeyF");
await page.waitForFunction(before => globalThis.__sharpAudit.actions.some(item => item.kind === "cargo" && item.at >= before), cargoBefore, {timeout: 2_000});
const cargo = await page.evaluate(before => {
  const match = globalThis.__sharpAudit.actions.find(item => item.kind === "cargo" && item.at >= before);
  return {before, at: match?.at ?? null, delayMs: match ? match.at - before : null};
}, cargoBefore);

const dryImpact = await page.evaluate(() => {
  const audio = globalThis.__freeRoamSharpAudio;
  const before = globalThis.__sharpAudit.buffers.length;
  audio.handleFreeEvent({
    type: "combat-hit",
    targets: [0],
    sourcePlayer: 0,
    targetPlayer: 1,
    weapon: "fists",
    heavy: false,
    x: 200,
    y: 160,
  }, 0);
  return {
    addedBuffers: globalThis.__sharpAudit.buffers.slice(before).map(item => item.name),
    sharpBusReady: Boolean(audio.sharpTransientBus),
    audioState: audio.ctx?.state,
  };
});

const diagnostics = await page.evaluate(() => ({
  network: globalThis.__freeRoam.networkDiagnostics?.(),
  actionKinds: globalThis.__sharpAudit.actions.map(item => item.kind),
  recentBuffers: globalThis.__sharpAudit.buffers.slice(-12).map(item => item.name),
}));

const result = {jump, attack, cargo, dryImpact, diagnostics};
for (const item of [jump, attack, cargo]) {
  if (item.delayMs == null || item.delayMs > 80) throw new Error(`sharp feedback too slow: ${JSON.stringify(result)}`);
}
if (!dryImpact.sharpBusReady || !dryImpact.addedBuffers.length) throw new Error(`dry impact path missing: ${JSON.stringify(result)}`);
await writeFile("sharp-feedback-result.json", JSON.stringify(result, null, 2));
console.log("SHARP_FEEDBACK_AUDIT " + JSON.stringify(result));
await browser.close();
