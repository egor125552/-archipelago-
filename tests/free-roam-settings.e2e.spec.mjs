import {test, expect} from "@playwright/test";

async function prepareContext(context) {
  await context.addInitScript(() => {
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
        this.speaking = true;
        queueMicrotask(() => {
          this.speaking = false;
          utterance?.onend?.();
        });
      },
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(window, "SpeechSynthesisUtterance", {configurable: true, writable: true, value: FakeUtterance});
    Object.defineProperty(window, "speechSynthesis", {configurable: true, writable: true, value: synth});
    Object.defineProperty(Element.prototype, "setPointerCapture", {configurable: true, value() {}});
    Object.defineProperty(Element.prototype, "releasePointerCapture", {configurable: true, value() {}});
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

test("interface, speech, and reload settings persist from the main menu into the game", async ({browser}, testInfo) => {
  const mobile = testInfo.project.name.includes("webkit");
  const context = await browser.newContext(mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}});
  await prepareContext(context);
  const page = await context.newPage();

  try {
    await page.goto("/free-roam.html", {waitUntil: "domcontentloaded"});
    await page.waitForFunction(() => Boolean(window.__freeRoam && window.__freeRoamSettings));

    await page.getByRole("button", {name: "Настройки"}).click();
    await expect(page.getByRole("dialog", {name: "Настройки"})).toBeVisible();
    await expect(page.getByRole("heading", {name: "Внешний вид"})).toBeVisible();
    await expect(page.getByRole("heading", {name: "Озвучка", exact: true})).toBeVisible();
    await expect(page.getByRole("heading", {name: "После обновления страницы"})).toBeVisible();
    await expect(page.getByText(/вариант «вернуться в тот же мир»/)).toBeVisible();

    // The settings dialog owns keyboard input before the game capture listener.
    // A focused range must therefore still implement normal screen-reader and
    // keyboard semantics instead of swallowing the arrow key.
    const speechRate = page.locator("#settingsSpeechRate");
    await expect(speechRate).toHaveValue("1.18");
    await speechRate.focus();
    await page.keyboard.press("ArrowRight");
    await expect(speechRate).toHaveValue("1.2");
    await expect(page.locator("#settingsSpeechRateValue")).toContainText("1.20");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("echo-free-roam-speech-rate"))).toBe("1.2");

    const autoResume = page.locator("#settingsAutoResumeButton");
    await expect(autoResume).toHaveAttribute("aria-pressed", "false");
    await expect(autoResume).toContainText("остаться в меню");

    const gameButtons = page.locator("#settingsGameButtonsButton");
    const initiallyEnabled = await gameButtons.getAttribute("aria-pressed") === "true";
    await gameButtons.click();
    const expectedEnabled = !initiallyEnabled;
    await expect(gameButtons).toHaveAttribute("aria-pressed", String(expectedEnabled));

    // Buttons inside the modal must also remain keyboard-activatable while
    // their Space/Enter keystrokes are kept away from gameplay controls.
    const quickSpeech = page.locator("#settingsQuickSpeechButton");
    await quickSpeech.focus();
    await page.keyboard.press("Enter");
    await expect(quickSpeech).toHaveAttribute("aria-pressed", "true");
    await page.locator("#settingsCloseButton").click();

    await page.locator("#hostButton").click();
    await expect(page.locator("#game")).toBeVisible();
    await expect(page.locator("#gameSettingsButton")).toBeVisible();
    await expect(page.locator("#speechButton")).toBeVisible();
    await expect(page.locator("#controlModeButton")).toBeHidden();
    if (expectedEnabled) await expect(page.locator("#controls")).toBeVisible();
    else await expect(page.locator("#controls")).toBeHidden();

    const roomBefore = await page.evaluate(() => window.__freeRoam.roomId());
    await page.reload({waitUntil: "domcontentloaded"});
    await page.waitForFunction(() => Boolean(window.__freeRoam && window.__freeRoamSettings));
    await expect(page.locator("#lobby")).toBeVisible();
    await expect(page.locator("#game")).toBeHidden();

    await page.getByRole("button", {name: "Настройки"}).click();
    await expect(page.locator("#settingsGameButtonsButton")).toHaveAttribute("aria-pressed", String(expectedEnabled));
    await expect(page.locator("#settingsQuickSpeechButton")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#settingsSpeechRate")).toHaveValue("1.2");
    await expect(autoResume).toHaveAttribute("aria-pressed", "false");
    await autoResume.click();
    await expect(autoResume).toHaveAttribute("aria-pressed", "true");
    await expect(autoResume).toContainText("вернуться в тот же мир");
    await page.locator("#settingsCloseButton").click();

    await page.reload({waitUntil: "domcontentloaded"});
    await expect(page.locator("#game")).toBeVisible({timeout: 10_000});
    await expect.poll(() => page.evaluate(() => window.__freeRoam.roomId()), {timeout: 10_000}).toBe(roomBefore);
    await expect(page.locator("#speechButton")).toBeVisible();
    if (expectedEnabled) await expect(page.locator("#controls")).toBeVisible();
    else await expect(page.locator("#controls")).toBeHidden();

    await page.locator("#gameSettingsButton").click();
    await expect(page.locator("#settingsAutoResumeButton")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#settingsSpeechRate")).toHaveValue("1.2");
  } finally {
    await context.close();
  }
});
