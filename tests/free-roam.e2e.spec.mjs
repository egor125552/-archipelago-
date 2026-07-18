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

    // Synthetic PointerEvents in automation are not registered as native
    // active pointers, so neutralize capture while preserving app semantics.
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

test("two nearby players keep speech, gestures, tow and damage-control mechanics", async ({browser}, testInfo) => {
  const mobile = testInfo.project.name.includes("webkit");
  const contextOptions = mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}};
  const hostContext = await browser.newContext(contextOptions);
  const crewContext = await browser.newContext(contextOptions);
  await prepareContext(hostContext);
  await prepareContext(crewContext);

  const host = await hostContext.newPage();
  const crew = await crewContext.newPage();

  try {
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

    // F must work immediately because the boats spawn inside tow range.
    await host.keyboard.press("f");
    await expect.poll(() => host.evaluate(() => Boolean(window.__freeRoam.getWorld()?.tow))).toBe(true);
    await host.waitForTimeout(180);
    await host.keyboard.press("f");
    await expect.poll(() => host.evaluate(() => Boolean(window.__freeRoam.getWorld()?.tow))).toBe(false);

    // The second real browser controls its own boat through the Worker.
    await crew.keyboard.down("ArrowUp");
    await crew.waitForTimeout(650);
    await crew.keyboard.up("ArrowUp");
    await expect.poll(() => host.evaluate(() => Math.abs(window.__freeRoam.getWorld()?.boats?.[1]?.speed || 0))).toBeGreaterThan(1);

    // A synthetic VoiceOver-style click used to disable speech forever.
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

    // One-finger swipe-and-hold must keep steering until release.
    const surface = host.locator("#playSurface");
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    const startX = box.x + box.width * 0.45;
    const startY = box.y + box.height * 0.42;
    await surface.dispatchEvent("pointerdown", touch("pointerdown", 21, startX, startY));
    await surface.dispatchEvent("pointermove", touch("pointermove", 21, startX + 110, startY));
    await expect.poll(() => host.evaluate(() => window.__freeRoam.input.right)).toBe(true);
    await surface.dispatchEvent("pointerup", touch("pointerup", 21, startX + 110, startY));
    await expect.poll(() => host.evaluate(() => window.__freeRoam.input.right)).toBe(false);

    // A short two-finger tap toggles the existing pump, not a new mechanic.
    const beforePump = await host.evaluate(() => window.__freeRoam.input.pump);
    await surface.dispatchEvent("pointerdown", touch("pointerdown", 31, startX - 20, startY));
    await surface.dispatchEvent("pointerdown", touch("pointerdown", 32, startX + 20, startY));
    await surface.dispatchEvent("pointerup", touch("pointerup", 31, startX - 20, startY));
    await surface.dispatchEvent("pointerup", touch("pointerup", 32, startX + 20, startY));
    await expect.poll(() => host.evaluate(() => window.__freeRoam.input.pump)).toBe(!beforePump);

    // Pump rate is exercised through the browser client and authoritative host loop.
    await host.evaluate(() => {
      const boat = window.__freeRoam.getWorld().boats[0];
      boat.water = 30;
      boat.leak = 0;
    });
    if (!(await host.evaluate(() => window.__freeRoam.input.pump))) await host.keyboard.press("c");
    await expect.poll(() => host.evaluate(() => window.__freeRoam.getWorld().boats[0].water)).toBeLessThan(28);
    await host.keyboard.press("c");

    // Existing plate duration and repair amount remain active in the browser.
    await host.evaluate(() => {
      const boat = window.__freeRoam.getWorld().boats[0];
      boat.speed = 0;
      boat.throttle = 0;
      boat.hull = 45;
      boat.leak = 4;
    });
    await host.keyboard.press("v");
    await expect.poll(
      () => host.evaluate(() => window.__freeRoam.getWorld().boats[0].hull),
      {timeout: 6_000},
    ).toBeGreaterThanOrEqual(67);

    // Space is the familiar floating brake while the player is in a boat.
    await host.evaluate(() => {
      const boat = window.__freeRoam.getWorld().boats[0];
      boat.speed = 10;
      boat.throttle = 1;
    });
    await host.keyboard.press("Space");
    await expect.poll(() => host.evaluate(() => Math.abs(window.__freeRoam.getWorld().boats[0].speed))).toBeLessThanOrEqual(0.13);
  } finally {
    await hostContext.close();
    await crewContext.close();
  }
});
