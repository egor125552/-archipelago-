import {test, expect} from "@playwright/test";

async function prepareContext(context) {
  await context.addInitScript(() => {
    window.__spoken = [];

    class FakeUtterance {
      constructor(text = "") {
        this.text = String(text);
        this.lang = "";
        this.rate = 1;
        this.pitch = 1;
        this.voice = null;
        this.onend = null;
        this.onerror = null;
      }
    }

    const fakeVoice = {name: "Milena Enhanced", lang: "ru-RU", voiceURI: "test-milena"};
    const synth = {
      speaking: false,
      pending: false,
      getVoices: () => [fakeVoice],
      cancel() { this.speaking = false; this.pending = false; },
      speak(utterance) {
        window.__spoken.push(String(utterance?.text || ""));
        this.speaking = true;
        queueMicrotask(() => {
          this.speaking = false;
          utterance?.onend?.();
        });
      },
      addEventListener() {},
      removeEventListener() {},
    };

    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      writable: true,
      value: FakeUtterance,
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      writable: true,
      value: synth,
    });
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value() {},
    });
    Object.defineProperty(Element.prototype, "releasePointerCapture", {
      configurable: true,
      value() {},
    });
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

function pointer(type, pointerId = 71) {
  return {
    pointerType: "mouse",
    pointerId,
    isPrimary: true,
    clientX: 20,
    clientY: 20,
    buttons: type === "pointerup" ? 0 : 1,
    bubbles: true,
    cancelable: true,
  };
}

async function holdButton(button, milliseconds, pointerId = 71) {
  await button.dispatchEvent("pointerdown", pointer("pointerdown", pointerId));
  await button.page().waitForTimeout(milliseconds);
  await button.dispatchEvent("pointerup", pointer("pointerup", pointerId));
}

async function createPair(browser, testInfo) {
  const mobile = testInfo.project.name.includes("webkit");
  const options = mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}};
  const captainContext = await browser.newContext(options);
  const crewContext = await browser.newContext(options);
  await prepareContext(captainContext);
  await prepareContext(crewContext);
  const captain = await captainContext.newPage();
  const crew = await crewContext.newPage();
  await Promise.all([
    captain.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
    crew.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
  ]);

  await captain.getByRole("button", {name: "Создать свободный мир"}).click();
  await expect(captain.locator("#game")).toBeVisible();
  const soloStatus = await captain.evaluate(() => window.__freeRoam.status());
  expect(soloStatus).toContain("Пока ждём второго игрока");

  await crew.getByRole("button", {name: "Войти в ближайший мир"}).click();
  await expect(crew.locator("#game")).toBeVisible();
  await expect.poll(() => captain.evaluate(() => window.__freeRoam.getWorld()?.freeActivities?.presence)).toEqual([true, true]);
  await expect.poll(() => crew.evaluate(() => window.__freeRoam.getWorld()?.freeActivities?.presence)).toEqual([true, true]);
  return {captainContext, crewContext, captain, crew};
}

function boatPosition(page, index) {
  return page.evaluate(playerIndex => {
    const boat = window.__freeRoam.getWorld()?.boats?.[playerIndex];
    return boat && {x: boat.x, y: boat.y, heading: boat.heading, speed: boat.speed};
  }, index);
}

test("two independent browsers drive one Cloudflare-owned world", async ({browser}, testInfo) => {
  const {captainContext, crewContext, captain, crew} = await createPair(browser, testInfo);
  try {
    const roomIds = await Promise.all([
      captain.evaluate(() => window.__freeRoam.roomId()),
      crew.evaluate(() => window.__freeRoam.roomId()),
    ]);
    expect(roomIds[0]).toBe(roomIds[1]);

    const captainBefore = await boatPosition(captain, 0);
    await holdButton(captain.locator("#upButton"), 720, 81);
    await expect.poll(async () => (await boatPosition(crew, 0)).y).toBeLessThan(captainBefore.y - 0.2);

    const crewBefore = await boatPosition(crew, 1);
    const crewUp = crew.locator("#upButton");
    const crewLeft = crew.locator("#leftButton");
    await crewUp.dispatchEvent("pointerdown", pointer("pointerdown", 91));
    await crewLeft.dispatchEvent("pointerdown", pointer("pointerdown", 92));
    await crew.waitForTimeout(720);
    await crewLeft.dispatchEvent("pointerup", pointer("pointerup", 92));
    await crewUp.dispatchEvent("pointerup", pointer("pointerup", 91));
    await expect.poll(async () => (await boatPosition(captain, 1)).y).toBeLessThan(crewBefore.y - 0.2);
    await expect.poll(async () => Math.abs((await boatPosition(captain, 1)).heading)).toBeGreaterThan(0.5);

    const [captainView, crewView] = await Promise.all([
      boatPosition(captain, 1),
      boatPosition(crew, 1),
    ]);
    expect(Math.hypot(captainView.x - crewView.x, captainView.y - crewView.y)).toBeLessThan(2);

    const networkText = await crew.locator("#networkValue").innerText();
    expect(networkText).toContain("сеть");
    expect(networkText).toContain("управление");

    await crew.evaluate(() => {
      const forged = window.__freeRoam.getWorld();
      forged.boats[1].x += 500;
      forged.players[1].x += 500;
      window.__freeRoam.setWorld(forged);
    });
    await expect.poll(async () => (await boatPosition(crew, 1)).x).toBeLessThan(420);
  } finally {
    await captainContext.close();
    await crewContext.close();
  }
});

test("a two-second blocked browser catches up without replaying a snapshot backlog", async ({browser}, testInfo) => {
  const {captainContext, crewContext, captain, crew} = await createPair(browser, testInfo);
  try {
    const before = await crew.evaluate(() => window.__freeRoam.networkDiagnostics());
    const captainBefore = await boatPosition(captain, 0);
    await Promise.all([
      crew.evaluate(() => {
        const until = performance.now() + 2_000;
        while (performance.now() < until) Math.sqrt(144);
      }),
      holdButton(captain.locator("#upButton"), 1_850, 101),
    ]);

    await expect.poll(
      () => crew.evaluate(() => window.__freeRoam.networkDiagnostics().stateAgeMs),
      {timeout: 5_000},
    ).toBeLessThan(500);
    const after = await crew.evaluate(() => window.__freeRoam.networkDiagnostics());
    expect(after.stateSequence - before.stateSequence).toBeGreaterThan(30);
    expect(after.receivedStateCount - before.receivedStateCount).toBeLessThanOrEqual(12);
    await expect.poll(async () => (await boatPosition(crew, 0)).y).toBeLessThan(captainBefore.y - 2);

    await crew.evaluate(() => { window.__spoken.length = 0; });
    await crew.getByRole("button", {name: "Где я?"}).click();
    await expect.poll(() => crew.evaluate(() => window.__spoken.length)).toBeGreaterThan(0);
    expect(await crew.evaluate(() => window.__spoken.at(-1))).not.toContain("Пока ждём второго игрока");
  } finally {
    await captainContext.close();
    await crewContext.close();
  }
});

test("the same role reconnects to the live server room", async ({browser}, testInfo) => {
  const {captainContext, crewContext, captain, crew} = await createPair(browser, testInfo);
  try {
    const roomBefore = await crew.evaluate(() => window.__freeRoam.roomId());
    const captainWorldTime = await captain.evaluate(() => window.__freeRoam.getWorld().time);
    const stateCountBefore = await crew.evaluate(() => window.__freeRoam.networkDiagnostics().receivedStateCount);
    await crew.evaluate(() => window.__freeRoam.disconnectForTest());
    await expect.poll(
      () => crew.evaluate(() => window.__freeRoam.networkDiagnostics().receivedStateCount),
      {timeout: 6_000},
    ).toBeGreaterThan(stateCountBefore);
    expect(await crew.evaluate(() => window.__freeRoam.roomId())).toBe(roomBefore);
    await expect.poll(
      () => crew.evaluate(() => window.__freeRoam.getWorld().time),
      {timeout: 6_000},
    ).toBeGreaterThan(captainWorldTime);
    await expect.poll(() => captain.evaluate(() => window.__freeRoam.getWorld().freeActivities.presence[1])).toBe(true);
  } finally {
    await captainContext.close();
    await crewContext.close();
  }
});
