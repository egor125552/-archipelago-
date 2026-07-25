import assert from "node:assert/strict";
import fs from "node:fs";
import {chromium} from "playwright";

const phase = process.argv[2];
const statePath = "test-results/saved-world-browser-state.json";
const expectedPath = "test-results/saved-world-expected.json";
const baseURL = "http://127.0.0.1:8787";

async function waitFor(fn, {timeout = 12_000, interval = 100, label = "condition"} = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function worldSnapshot(page) {
  return page.evaluate(() => {
    const world = window.__freeRoam?.getWorld?.();
    const boat = world?.boats?.[0];
    return {
      room: window.__freeRoam?.roomId?.() || "",
      worldTime: Number(world?.time) || 0,
      boat: boat && {x: boat.x, y: boat.y, heading: boat.heading, speed: boat.speed},
      stage: world?.freeScenario?.stage ?? null,
      delivered: world?.freeScenario?.delivered ?? null,
      saved: window.__freeRoamSavedWorld?.active?.() || null,
    };
  });
}

async function createPhase(browser) {
  fs.mkdirSync("test-results", {recursive: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  await page.goto(`${baseURL}/free-roam.html`, {waitUntil: "domcontentloaded"});
  await waitFor(() => page.evaluate(() => Boolean(window.__freeRoam && window.__freeRoamSavedWorld)), {label: "game APIs"});
  await page.locator("#hostButton").click();
  await waitFor(() => page.locator("#game").evaluate(element => !element.hidden), {label: "new world"});
  await waitFor(async () => (await worldSnapshot(page)).room, {label: "room id"});

  const before = await worldSnapshot(page);
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(1_650);
  await page.keyboard.up("ArrowUp");
  await page.waitForTimeout(1_500);
  const after = await worldSnapshot(page);
  assert(after.boat && before.boat, "boat state missing");
  assert(Math.hypot(after.boat.x - before.boat.x, after.boat.y - before.boat.y) > 2, "real client did not move the authoritative boat");
  assert.equal(after.saved?.room, after.room, "local saved world was not written");
  assert.equal(after.saved?.role, "captain", "saved role is not captain");

  const serverSaved = await page.evaluate(async room => {
    const response = await fetch(`/api/saved-world?room=${encodeURIComponent(room)}`, {cache: "no-store"});
    return response.json();
  }, after.room);
  assert.equal(serverSaved.exists, true, "server did not persist the created room");

  fs.writeFileSync(expectedPath, JSON.stringify(after, null, 2));
  await context.storageState({path: statePath});
  console.log("SAVED_WORLD_CREATE", JSON.stringify({before, after, serverSaved}));
  await context.close();
}

async function resumePhase(browser) {
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const context = await browser.newContext({storageState: statePath, viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  await page.goto(`${baseURL}/free-roam.html`, {waitUntil: "domcontentloaded"});
  await waitFor(() => page.evaluate(() => Boolean(window.__freeRoam && window.__freeRoamSavedWorld)), {label: "restored game APIs"});

  const joinLabel = await page.locator("#joinButton").innerText();
  assert(joinLabel.includes("Вернуться в сохранённый мир"), `unexpected saved-world label: ${joinLabel}`);
  assert(joinLabel.includes(expected.room), `saved room code missing from button: ${joinLabel}`);

  await page.locator("#joinButton").click();
  await waitFor(() => page.locator("#game").evaluate(element => !element.hidden), {label: "saved world game"});
  const resumed = await waitFor(async () => {
    const snapshot = await worldSnapshot(page);
    return snapshot.room === expected.room && snapshot.boat ? snapshot : null;
  }, {label: "same saved room"});

  const positionError = Math.hypot(resumed.boat.x - expected.boat.x, resumed.boat.y - expected.boat.y);
  assert(positionError < 3.5, `saved boat position was reset: error ${positionError.toFixed(2)} m`);
  assert(resumed.worldTime >= expected.worldTime, "saved world time went backwards after Worker restart");
  assert.equal(resumed.stage, expected.stage, "scenario stage reset after Worker restart");

  await page.reload({waitUntil: "domcontentloaded"});
  await waitFor(() => page.evaluate(() => Boolean(window.__freeRoam && window.__freeRoamSavedWorld)), {label: "lobby after reload"});
  await waitFor(() => page.locator("#lobby").evaluate(element => !element.hidden), {label: "saved-world lobby"});
  const createLabel = await page.locator("#hostButton").innerText();
  assert(createLabel.includes("удалить сохранённый"), `create-new warning missing: ${createLabel}`);

  await page.locator("#hostButton").click();
  await waitFor(() => page.locator("#game").evaluate(element => !element.hidden), {timeout: 15_000, label: "replacement world"});
  const replacement = await waitFor(async () => {
    const snapshot = await worldSnapshot(page);
    return snapshot.room && snapshot.room !== expected.room ? snapshot : null;
  }, {timeout: 15_000, label: "new room id"});

  const oldStatus = await page.evaluate(async room => {
    const response = await fetch(`/api/saved-world?room=${encodeURIComponent(room)}`, {cache: "no-store"});
    return response.json();
  }, expected.room);
  assert.equal(oldStatus.exists, false, "old saved world still exists after Create new");
  assert.equal(replacement.saved?.room, replacement.room, "replacement world was not saved locally");
  assert.notEqual(replacement.room, expected.room, "Create new reused the old room code");

  console.log("SAVED_WORLD_RESUME", JSON.stringify({expected, resumed, positionError, replacement, oldStatus}));
  await context.close();
}

if (!["create", "resume"].includes(phase)) throw new Error("Usage: node saved-world-real-client-audit.mjs create|resume");
const browser = await chromium.launch({headless: true});
try {
  if (phase === "create") await createPhase(browser);
  else await resumePhase(browser);
} finally {
  await browser.close();
}
