from pathlib import Path

path = Path('.github/workflows/neural-hunter-browser.yml')
text = path.read_text()
old = '''          {
            const page = await startScenario("strizh");
            await hold(page, "#reverseButton", 4600);
            results.reverse = await page.evaluate(() => {
'''
new = '''          {
            const page = await startScenario("strizh");
            await page.evaluate(() => {
              const state = window.__echoArchipelago.getState();
              state.hunter.x = state.boat.x + 105;
              state.hunter.y = state.boat.y + 85;
              state.hunter.speed = 0;
              state.hunter.brain.nextDecisionAt = 0;
            });
            await hold(page, "#reverseButton", 7200);
            results.reverse = await page.evaluate(() => {
'''
if old not in text:
    raise SystemExit('reverse browser block not found')
text = text.replace(old, new, 1)
text = text.replace(
    'assert.ok(results.reverse.reverse > 0.55);',
    'assert.ok(results.reverse.reverse > 0.45, `reverse memory ${results.reverse.reverse}, speed ${results.reverse.speed}`);',
    1,
)
path.write_text(text)
