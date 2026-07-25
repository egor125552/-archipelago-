from pathlib import Path

client = Path("public/src/free-roam-v4.js")
text = client.read_text(encoding="utf-8")
old = '''    } else if (!event.repeat && event.code === "KeyQ") {
      event.preventDefault();
      actionPulse("sonar");
'''
new = '''    } else if (!event.repeat && event.code === "KeyQ") {
      event.preventDefault();
      useSonarOrCombatTargets();
'''
if old not in text:
    raise SystemExit("KeyQ sonar marker missing")
client.write_text(text.replace(old, new, 1), encoding="utf-8")

html = Path("public/free-roam.html")
text = html.read_text(encoding="utf-8")
if 'src/free-roam-v4.js?v=53' not in text:
    raise SystemExit("free-roam module version marker missing")
html.write_text(text.replace('src/free-roam-v4.js?v=53', 'src/free-roam-v4.js?v=54', 1), encoding="utf-8")

cache_test = Path("tests/free-roam-target-reconnect-v154.test.mjs")
text = cache_test.read_text(encoding="utf-8")
text = text.replace(r'free-roam-v4\.js\?v=53', r'free-roam-v4\.js\?v=54')
cache_test.write_text(text, encoding="utf-8")

Path("tests/free-roam-local-sonar-cue.test.mjs").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("keyboard sonar uses the same immediate local-feedback path as buttons and gestures", async () => {
  const source = await readFile(new URL("../public/src/free-roam-v4.js", import.meta.url), "utf8");
  assert.match(source, /event\.code === "KeyQ"[\s\S]{0,140}useSonarOrCombatTargets\(\)/);
  assert.match(source, /function useSonarOrCombatTargets\([\s\S]{0,520}playLocalCommandCue\?\.\("sonar"\)[\s\S]{0,120}actionPulse\("sonar"\)/);
});
''', encoding="utf-8")
