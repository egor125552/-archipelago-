import {writeFile} from "node:fs/promises";
import {webkit} from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});
await page.goto("http://127.0.0.1:8788/free-roam.html", {waitUntil: "domcontentloaded"});
await page.click("#hostButton");
await page.waitForFunction(() => !document.querySelector("#game")?.hidden && globalThis.__freeRoam?.getWorld?.(), null, {timeout: 20_000});
await page.waitForTimeout(2200);

const before = await page.evaluate(() => ({
  at: performance.now(),
  count: globalThis.__sonarCueAudit?.length || 0,
  network: globalThis.__freeRoam?.networkDiagnostics?.(),
}));
await page.keyboard.press("KeyQ");
await page.waitForFunction(count => (globalThis.__sonarCueAudit?.length || 0) > count, before.count, {timeout: 1000});
const after = await page.evaluate(({startedAt, count}) => {
  const cue = (globalThis.__sonarCueAudit || [])[count];
  return {
    cue,
    delayMs: cue ? cue.at - startedAt : null,
    sonarInput: Boolean(globalThis.__freeRoam?.input?.sonar),
    network: globalThis.__freeRoam?.networkDiagnostics?.(),
  };
}, {startedAt: before.at, count: before.count});

const result = {before, after};
await writeFile("sonar-cue-result.json", JSON.stringify(result, null, 2));
console.log("SONAR_CUE_AUDIT " + JSON.stringify(result));
await browser.close();
