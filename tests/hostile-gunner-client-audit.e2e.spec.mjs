import {test, expect} from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

async function prepareContext(context) {
  await context.addInitScript(() => {
    localStorage.setItem("echo-free-roam-interface-settings-v1", JSON.stringify({
      gameButtons: true,
      quickControl: false,
      quickSpeech: false,
      autoResume: false,
    }));
  });
  await context.route("**/*", async route => {
    const url = route.request().url();
    if (/\.(?:ogg|mp3|wav)(?:\?|$)/i.test(url) || url.includes("/api/sound/")) {
      await route.fulfill({status: 204, contentType: "audio/ogg", body: ""});
      return;
    }
    await route.continue();
  });
}

async function createRealClient(browser, testInfo) {
  const mobile = testInfo.project.name.includes("webkit");
  const context = await browser.newContext(mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}});
  await prepareContext(context);
  const page = await context.newPage();
  await page.goto("/free-roam.html", {waitUntil: "domcontentloaded"});
  await page.getByRole("button", {name: "Создать свободный мир"}).click();
  await expect(page.locator("#game")).toBeVisible();
  await expect(page.locator("#controls")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__freeRoam.networkDiagnostics().receivedStateCount)).toBeGreaterThan(2);
  return {context, page};
}

async function setupScenario(page, variant) {
  const room = await page.evaluate(() => window.__freeRoam.roomId());
  const response = await page.evaluate(async ({room, variant}) => {
    const result = await fetch(`/api/test/gunner-scenario?room=${encodeURIComponent(room)}&variant=${encodeURIComponent(variant)}`, {
      method: "POST",
    });
    return {status: result.status, body: await result.json()};
  }, {room, variant});
  expect(response.status).toBe(200);
  await expect.poll(() => page.evaluate(() => {
    const world = window.__freeRoam.getWorld();
    return {
      mode: world?.players?.[0]?.mode,
      active: Boolean(world?.freeHostileGunners?.gunners?.some(gunner => gunner.active && !gunner.destroyed)),
    };
  }), {timeout: 10_000}).toEqual({mode: "foot", active: true});
  return response.body;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const world = window.__freeRoam.getWorld();
    const player = world.players[0];
    const gunner = (world.freeHostileGunners?.gunners || []).find(candidate => candidate.pursuerId === "audit-pursuer") || null;
    const escort = (world.freePursuerSquad?.escorts || []).find(candidate => candidate.id === "audit-pursuer") || null;
    const boat = world.boats[0];
    return {
      worldTime: world.time,
      mode: player.mode,
      x: player.x,
      y: player.y,
      health: player.combat?.health,
      alive: player.combat?.alive,
      boatHull: boat?.hull,
      boatWater: boat?.water,
      gunner: gunner && {
        x: gunner.x,
        y: gunner.y,
        active: gunner.active,
        destroyed: gunner.destroyed,
        returning: gunner.returning,
        aimRemaining: gunner.aimRemaining,
        burstRemaining: gunner.burstRemaining,
        fireCooldown: gunner.fireCooldown,
      },
      escort: escort && {x: escort.x, y: escort.y, active: escort.active, destroyed: escort.destroyed},
      projectileCount: world.freeHostileGunners?.projectiles?.length || 0,
      status: document.querySelector("#message")?.textContent?.trim() || "",
    };
  });
}

async function runSideways(page, milliseconds = 8_400) {
  const segments = [
    ["ArrowLeft", 1_800],
    ["ArrowRight", 3_600],
    ["ArrowLeft", 3_000],
  ];
  await page.keyboard.down("Shift");
  let elapsed = 0;
  for (const [key, duration] of segments) {
    await page.keyboard.down(key);
    await page.waitForTimeout(duration);
    await page.keyboard.up(key);
    elapsed += duration;
  }
  await page.keyboard.up("Shift");
  if (elapsed < milliseconds) await page.waitForTimeout(milliseconds - elapsed);
}

function gunnerEscortDistance(state) {
  if (!state.gunner || !state.escort) return null;
  return Math.hypot(state.gunner.x - state.escort.x, state.gunner.y - state.escort.y);
}

function writeReport(report, projectName) {
  fs.mkdirSync("test-results", {recursive: true});
  const output = path.join("test-results", `hostile-gunner-client-audit-${projectName}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log("HOSTILE_GUNNER_CLIENT_AUDIT", JSON.stringify(report));
}

test("real clients expose hostile gunner intelligence and mechanic failures", async ({browser}, testInfo) => {
  const {context, page} = await createRealClient(browser, testInfo);
  const report = {project: testInfo.project.name};
  try {
    await setupScenario(page, "standing");
    const standingStart = await snapshot(page);
    await page.waitForTimeout(8_400);
    const standingEnd = await snapshot(page);
    report.standing = {
      start: standingStart,
      end: standingEnd,
      damage: standingStart.health - standingEnd.health,
    };
    expect(standingEnd.alive).toBe(true);

    await setupScenario(page, "running");
    const runningStart = await snapshot(page);
    await runSideways(page);
    const runningEnd = await snapshot(page);
    report.running = {
      start: runningStart,
      end: runningEnd,
      damage: runningStart.health - runningEnd.health,
      horizontalTravel: Math.abs(runningEnd.x - runningStart.x),
    };
    expect(runningEnd.alive).toBe(true);

    await setupScenario(page, "roof");
    const roofCycles = [];
    const jumpButton = page.locator("#jumpButton");
    await expect(jumpButton).toBeVisible();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await expect.poll(() => page.evaluate(() => window.__freeRoam.getWorld().players[0].mode)).toBe("foot");
      await expect.poll(() => page.evaluate(() => Boolean(window.__freeRoam.getWorld().freeHostileGunners?.gunners?.some(gunner => gunner.active && !gunner.destroyed)))).toBe(true);
      const beforeRoof = await snapshot(page);

      await jumpButton.click();
      await expect.poll(() => page.evaluate(() => window.__freeRoam.getWorld().players[0].mode), {timeout: 5_000}).toBe("roof");
      await expect.poll(() => page.evaluate(() => {
        const gunner = window.__freeRoam.getWorld().freeHostileGunners?.gunners?.find(candidate => candidate.pursuerId === "audit-pursuer");
        return Boolean(gunner && (gunner.returning || !gunner.active));
      }), {timeout: 5_000}).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const gunner = window.__freeRoam.getWorld().freeHostileGunners?.gunners?.find(candidate => candidate.pursuerId === "audit-pursuer");
        return Boolean(gunner && !gunner.active);
      }), {timeout: 7_000}).toBe(true);

      const boarded = await snapshot(page);
      await page.waitForTimeout(1_500);
      const roofEnd = await snapshot(page);
      roofCycles.push({
        cycle: cycle + 1,
        beforeRoof,
        boarded,
        roofEnd,
        damageWhileRoof: beforeRoof.health - roofEnd.health,
        boardedDistanceFromBoat: gunnerEscortDistance(boarded),
      });

      await jumpButton.click();
      await expect.poll(() => page.evaluate(() => window.__freeRoam.getWorld().players[0].mode), {timeout: 5_000}).toBe("foot");
      await expect.poll(() => page.evaluate(() => Boolean(window.__freeRoam.getWorld().freeHostileGunners?.gunners?.some(gunner => gunner.active && !gunner.destroyed))), {timeout: 7_000}).toBe(true);
    }
    report.roofExploit = {
      cycles: roofCycles,
      allBoardedFarFromBoat: roofCycles.every(item => Number(item.boardedDistanceFromBoat) > 35),
      totalRoofDamage: roofCycles.reduce((sum, item) => sum + Number(item.damageWhileRoof || 0), 0),
    };
  } catch (error) {
    report.failure = String(error?.stack || error);
    throw error;
  } finally {
    writeReport(report, testInfo.project.name);
    await context.close();
  }
});
