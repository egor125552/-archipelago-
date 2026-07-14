from pathlib import Path

for file in Path("tests").glob("*.test.mjs"):
    text = file.read_text()
    text = text.replace(r"v=23\.0", r"v=24\.0")
    text = text.replace(r"v=23\\.0", r"v=24\\.0")
    file.write_text(text)

shore = Path("tests/shore-fuel-v21.test.mjs")
text = shore.read_text()
old = '''  run(restored, CONFIG.floatingBrakeCooldown + 0.1);
  assert.equal(getView(restored).floatingBrake.ready, true);
  assert.equal(command(restored, "anchor").ok, true);
});'''
new = '''  run(restored, CONFIG.floatingBrakeCooldown + 0.1);
  assert.equal(getView(restored).floatingBrake.ready, true);
  const stopped = command(restored, "anchor");
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "already-stopped");
  assert.equal(getView(restored).floatingBrake.ready, true);
  restored.boat.speed = 3;
  assert.equal(command(restored, "anchor").ok, true);
});'''
if old not in text:
    raise SystemExit("shore brake expectation not found")
shore.write_text(text.replace(old, new, 1))
