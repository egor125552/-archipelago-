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
        this.volume = 1;
        this.voice = null;
        this.onend = null;
        this.onerror = null;
      }
    }

    const fakeVoice = {name: "Milena Enhanced", lang: "ru-RU", voiceURI: "test-milena"};
    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: () => [fakeVoice],
      cancel() {
        this.speaking = false;
        this.pending = false;
      },
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

function touch(type, pointerId, x, y, extra = {}) {
  return {
    pointerType: "touch",
    pointerId,
    isPrimary: pointerId === 21 || pointerId === 31,
    clientX: x,
    clientY: y,
    buttons: type === "pointerup" ? 0 : 1,
    bubbles: true,
    cancelable: true,
    ...extra,
  };
}

async function holdButton(button, milliseconds, pointerId = 71) {
  await button.dispatchEvent("pointerdown", touch("pointerdown", pointerId, 20, 20));
  await button.page().waitForTimeout(milliseconds);
  await button.dispatchEvent("pointerup", touch("pointerup", pointerId, 20, 20));
}

async function createPair(browser, testInfo) {
  const mobile = testInfo.project.name.includes("webkit");
  const options = mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}};
  const hostContext = await browser.newContext(options);
  const crewContext = await browser.newContext(options);
  await prepareContext(hostContext);
  await prepareContext(crewContext);
  const host = await hostContext.newPage();
  const crew = await crewContext.newPage();
  await Promise.all([
    host.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
    crew.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
  ]);
  await host.getByRole("button", {name: "Создать свободный мир"}).click();
  await expect(host.locator("#game")).toBeVisible();
  await crew.getByRole("button", {name: "Войти в ближайший мир"}).click();
  await expect(crew.locator("#game")).toBeVisible();
  await expect.poll(() => host.evaluate(() => window.__freeRoam?.getWorld()?.players?.length || 0)).toBe(2);
  await expect.poll(() => crew.evaluate(() => window.__freeRoam?.getWorld()?.players?.length || 0)).toBe(2);
  return {hostContext, crewContext, host, crew};
}

test("two browsers operate nearby boats, a turning tow and spatial audio", async ({browser}, testInfo) => {
  const {hostContext, crewContext, host, crew} = await createPair(browser, testInfo);
  try {
    const spawn = await host.evaluate(() => {
      const world = window.__freeRoam.getWorld();
      const [first, second] = world.boats;
      return {
        distance: Math.hypot(first.x - second.x, first.y - second.y),
        modes: world.players.map(player => player.mode),
      };
    });
    expect(spawn.distance).toBeGreaterThanOrEqual(16);
    expect(spawn.distance).toBeLessThanOrEqual(24);
    expect(spawn.modes).toEqual(["boat", "boat"]);

    await expect.poll(() => host.evaluate(() => window.__freeRoam.audioDiagnostics()?.remoteGain || 0)).toBeGreaterThan(0);
    const nearAudio = await host.evaluate(() => ({...window.__freeRoam.audioDiagnostics()}));
    expect(nearAudio.remotePan).toBeGreaterThan(0.2);

    await host.evaluate(() => {
      const world = window.__freeRoam.getWorld();
      world.boats[1].x = 365;
      world.players[1].x = 365;
      window.__freeRoam.setWorld(world);
    });
    await host.waitForTimeout(120);
    const farAudio = await host.evaluate(() => ({...window.__freeRoam.audioDiagnostics()}));
    expect(farAudio.remoteGain).toBeLessThan(nearAudio.remoteGain);
    expect(farAudio.remoteLowpass).toBeLessThan(nearAudio.remoteLowpass);

    await host.evaluate(() => {
      const world = window.__freeRoam.getWorld();
      Object.assign(world.boats[0], {x: 199, y: 158, heading: 0, speed: 0, throttle: 0});
      Object.assign(world.boats[1], {x: 219, y: 158, heading: 0, speed: 0, throttle: 0});
      Object.assign(world.players[0], {x: 199, y: 158, heading: 0, mode: "boat", activeBoat: 0});
      Object.assign(world.players[1], {x: 219, y: 158, heading: 0, mode: "boat", activeBoat: 1});
      window.__freeRoam.setWorld(world);
    });

    await host.locator("#actionButton").click();
    await expect.poll(() => host.evaluate(() => Boolean(window.__freeRoam.getWorld()?.tow))).toBe(true);

    const up = host.locator("#upButton");
    const right = host.locator("#rightButton");
    await up.dispatchEvent("pointerdown", touch("pointerdown", 81, 20, 20));
    await right.dispatchEvent("pointerdown", touch("pointerdown", 82, 20, 20));
    await host.waitForTimeout(2600);
    await right.dispatchEvent("pointerup", touch("pointerup", 82, 20, 20));
    await up.dispatchEvent("pointerup", touch("pointerup", 81, 20, 20));

    const towState = await host.evaluate(() => {
      const world = window.__freeRoam.getWorld();
      const tow = world.tow;
      if (!tow) return null;
      const tower = world.boats[tow.towerBoat];
      const towed = world.boats[tow.towedBoat];
      return {
        distance: Math.hypot(tower.x - towed.x, tower.y - towed.y),
        tension: tow.tension,
        towedHeading: towed.heading,
        diagnostics: {...window.__freeRoam.audioDiagnostics()},
      };
    });
    expect(towState).not.toBeNull();
    expect(towState.distance).toBeLessThan(35);
    expect(Math.abs(towState.towedHeading)).toBeGreaterThan(3);
    expect(towState.tension).toBeGreaterThanOrEqual(0);
    expect(towState.tension).toBeLessThanOrEqual(1.45);
    expect(Number.isFinite(towState.diagnostics.towPan)).toBe(true);

    await host.locator("#actionButton").click();
    await expect.poll(() => host.evaluate(() => Boolean(window.__freeRoam.getWorld()?.tow))).toBe(false);

    await holdButton(crew.locator("#upButton"), 650, 91);
    await expect.poll(() => host.evaluate(() => Math.abs(window.__freeRoam.getWorld()?.boats?.[1]?.speed || 0))).toBeGreaterThan(1);

    await host.evaluate(() => {
      window.__spoken.length = 0;
      document.getElementById("statusButton").dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 0,
      }));
    });
    await expect.poll(() => host.evaluate(() => window.__spoken.length)).toBeGreaterThan(0);
    expect(await host.evaluate(() => window.__spoken.at(-1))).toContain("Ты");

    const surface = host.locator("#playSurface");
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    const startX = box.x + box.width * 0.45;
    const startY = box.y + box.height * 0.42;
    const beforePump = await host.evaluate(() => window.__freeRoam.input.pump);
    await surface.dispatchEvent("pointerdown", touch("pointerdown", 31, startX - 20, startY));
    await surface.dispatchEvent("pointerdown", touch("pointerdown", 32, startX + 20, startY));
    await surface.dispatchEvent("pointerup", touch("pointerup", 31, startX - 20, startY));
    await surface.dispatchEvent("pointerup", touch("pointerup", 32, startX + 20, startY));
    await expect.poll(() => host.evaluate(() => window.__freeRoam.input.pump)).toBe(!beforePump);

    await host.evaluate(() => {
      const boat = window.__freeRoam.getWorld().boats[0];
      boat.water = 30;
      boat.leak = 0;
    });
    if (!(await host.evaluate(() => window.__freeRoam.input.pump))) await host.locator("#pumpButton").click();
    await expect.poll(() => host.evaluate(() => window.__freeRoam.getWorld().boats[0].water)).toBeLessThan(28);
    await host.locator("#pumpButton").click();

    await host.evaluate(() => {
      const boat = window.__freeRoam.getWorld().boats[0];
      Object.assign(boat, {speed: 0, throttle: 0, hull: 45, leak: 4});
    });
    await host.locator("#repairButton").click();
    await expect.poll(
      () => host.evaluate(() => window.__freeRoam.getWorld().boats[0].hull),
      {timeout: 6_000},
    ).toBeGreaterThanOrEqual(67);

    await host.evaluate(() => {
      const boat = window.__freeRoam.getWorld().boats[0];
      boat.speed = 10;
      boat.throttle = 1;
    });
    await host.locator("#jumpButton").click();
    await expect.poll(() => host.evaluate(() => Math.abs(window.__freeRoam.getWorld().boats[0].speed))).toBeLessThanOrEqual(0.13);

    await host.evaluate(() => {
      const world = window.__freeRoam.getWorld();
      world.boats[0].driver = null;
      world.boats[1].driver = null;
      Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 180, y: 50, heading: 0});
      Object.assign(world.players[1], {mode: "foot", activeBoat: null, x: 220, y: 50, heading: 0});
      window.__freeRoam.setWorld(world);
    });
    await expect.poll(() => crew.evaluate(() => window.__freeRoam.getWorld()?.players?.[0]?.mode)).toBe("foot");
    await holdButton(host.locator("#rightButton"), 620, 101);
    await expect.poll(() => crew.evaluate(() => window.__freeRoam.audioDiagnostics()?.movementGain || 0)).toBeGreaterThan(0);
    expect(await crew.evaluate(() => window.__freeRoam.audioDiagnostics().movementPan)).toBeLessThan(0);
  } finally {
    await hostContext.close();
    await crewContext.close();
  }
});

test("buttons, Shift, long swipe, jump and finite shore work in the browser", async ({browser}, testInfo) => {
  const mobile = testInfo.project.name.includes("webkit");
  const context = await browser.newContext(mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}});
  await prepareContext(context);
  const page = await context.newPage();
  try {
    await page.goto("/free-roam.html", {waitUntil: "domcontentloaded"});
    await page.getByRole("button", {name: "Создать свободный мир"}).click();
    await expect(page.locator("#game")).toBeVisible();

    await page.evaluate(() => {
      const world = window.__freeRoam.getWorld();
      Object.assign(world.boats[0], {x: 200, y: 80, heading: 0, speed: 0, throttle: 0});
      Object.assign(world.players[0], {x: 200, y: 80, heading: 0, mode: "boat", activeBoat: 0});
      window.__freeRoam.setWorld(world);
    });
    await page.locator("#actionButton").click();
    await expect.poll(() => page.evaluate(() => window.__freeRoam.getWorld().players[0].mode)).toBe("foot");

    await page.evaluate(() => {
      const player = window.__freeRoam.getWorld().players[0];
      Object.assign(player, {x: 180, y: 50, mode: "foot", activeBoat: null, running: false});
    });
    await holdButton(page.locator("#rightButton"), 520, 111);
    const walked = await page.evaluate(() => window.__freeRoam.getWorld().players[0].x - 180);

    await page.evaluate(() => {
      const player = window.__freeRoam.getWorld().players[0];
      Object.assign(player, {x: 180, y: 50, mode: "foot", activeBoat: null, running: false});
    });
    await page.keyboard.down("Shift");
    await holdButton(page.locator("#rightButton"), 520, 112);
    await page.keyboard.up("Shift");
    const ran = await page.evaluate(() => window.__freeRoam.getWorld().players[0].x - 180);
    expect(ran).toBeGreaterThan(walked * 1.45);

    const surface = page.locator("#playSurface");
    const box = await surface.boundingBox();
    const x = box.x + box.width * 0.4;
    const y = box.y + box.height * 0.45;
    await surface.dispatchEvent("pointerdown", touch("pointerdown", 21, x, y));
    await surface.dispatchEvent("pointermove", touch("pointermove", 21, x + 150, y));
    await expect.poll(() => page.evaluate(() => window.__freeRoam.input.right)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__freeRoam.input.run)).toBe(true);
    await surface.dispatchEvent("pointerup", touch("pointerup", 21, x + 150, y));
    await expect.poll(() => page.evaluate(() => window.__freeRoam.input.right)).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__freeRoam.input.run)).toBe(false);

    await page.evaluate(() => {
      const player = window.__freeRoam.getWorld().players[0];
      Object.assign(player, {x: 200, y: 50, mode: "foot", activeBoat: null, airborne: false, jumpHeight: 0});
    });
    await page.locator("#jumpButton").click();
    await page.waitForTimeout(90);
    expect(await page.evaluate(() => window.__freeRoam.getWorld().players[0].jumpHeight)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.__freeRoam.getWorld().players[0].airborne), {timeout: 2_000}).toBe(false);

    await page.evaluate(() => {
      const player = window.__freeRoam.getWorld().players[0];
      Object.assign(player, {x: 301, y: 50, mode: "foot", activeBoat: null});
    });
    await page.keyboard.down("Shift");
    await holdButton(page.locator("#rightButton"), 650, 113);
    await page.keyboard.up("Shift");
    expect(await page.evaluate(() => window.__freeRoam.getWorld().players[0].x)).toBeLessThanOrEqual(302);
    await expect(page.locator("#message")).toContainText("Край береговой площадки");

    await page.evaluate(() => {
      const player = window.__freeRoam.getWorld().players[0];
      Object.assign(player, {x: 200, y: 73, mode: "foot", activeBoat: null, running: false});
    });
    await holdButton(page.locator("#downButton"), 420, 114);
    await expect.poll(() => page.evaluate(() => window.__freeRoam.getWorld().players[0].mode)).toBe("swim");
  } finally {
    await context.close();
  }
});

test("joining fills a room that is waiting for its creator", async ({browser}, testInfo) => {
  const mobile = testInfo.project.name.includes("webkit");
  const options = mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}};
  const hostContext = await browser.newContext(options);
  const crewContext = await browser.newContext(options);
  const newcomerContext = await browser.newContext(options);
  await prepareContext(hostContext);
  await prepareContext(crewContext);
  await prepareContext(newcomerContext);
  const host = await hostContext.newPage();
  const crew = await crewContext.newPage();
  const newcomer = await newcomerContext.newPage();
  try {
    await Promise.all([
      host.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
      crew.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
      newcomer.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
    ]);
    await host.getByRole("button", {name: "Создать свободный мир"}).click();
    await crew.getByRole("button", {name: "Войти в ближайший мир"}).click();
    await expect(crew.locator("#game")).toBeVisible();

    await hostContext.close();
    await expect.poll(() => crew.evaluate(async () => {
      const response = await fetch("/api/rooms?mode=free", {cache: "no-store"});
      const data = await response.json();
      return data.rooms?.[0]?.waitingFor || null;
    })).toBe("captain");

    await newcomer.getByRole("button", {name: "Войти в ближайший мир"}).click();
    await expect(newcomer.locator("#game")).toBeVisible();
    await expect.poll(() => newcomer.evaluate(() => window.__freeRoam?.isHost?.())).toBe(true);
    await expect.poll(() => crew.evaluate(() => window.__freeRoam?.getWorld()?.players?.length || 0)).toBe(2);
    await expect.poll(() => newcomer.evaluate(async () => {
      const response = await fetch("/api/rooms?mode=free", {cache: "no-store"});
      const data = await response.json();
      return data.rooms?.length ?? -1;
    })).toBe(0);
  } finally {
    await crewContext.close();
    await newcomerContext.close();
  }
});
