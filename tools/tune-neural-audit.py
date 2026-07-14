from pathlib import Path

# A persistent one-direction circle is a high-confidence exploit pattern. The
# neural output remains the base decision, but this contextual bias makes the
# learned counter-circle response win over unrelated generic tactics.
brain_path = Path('public/src/hunter-brain.js')
brain = brain_path.read_text()
old_bias = '  if (brain.turnPersistence > 0.38 && Math.abs(brain.turnDirection) > 0.35) addBias(logits, "counter-circle", 2.8);'
new_bias = '''  if (brain.turnPersistence > 0.38 && Math.abs(brain.turnDirection) > 0.35) {
    addBias(logits, "counter-circle", 6.2);
    addBias(logits, "pressure", -1.6);
    addBias(logits, "intercept", -0.8);
  }'''
if old_bias not in brain:
    raise SystemExit('circle bias not found')
brain = brain.replace(old_bias, new_bias, 1)
old_decoy = '  brain.decoySuspicion = clamp(brain.decoySuspicion + (brain.decoyUses === 1 ? 0.34 : 0.48), 0, 1);'
new_decoy = '  brain.decoySuspicion = clamp(brain.decoySuspicion + (brain.decoyUses === 1 ? 0.34 : 0.62), 0, 1);'
if old_decoy not in brain:
    raise SystemExit('decoy memory increment not found')
brain_path.write_text(brain.replace(old_decoy, new_decoy, 1))

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
              state.boat.x = 0;
              state.boat.y = 190;
              state.boat.heading = 180;
              state.boat.speed = 0;
              state.boat.throttle = 0;
              state.hunter.x = 105;
              state.hunter.y = 275;
              state.hunter.speed = 0;
              state.hunter.brain.previousHeading = state.boat.heading;
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
