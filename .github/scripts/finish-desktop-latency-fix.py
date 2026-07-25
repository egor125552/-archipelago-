from pathlib import Path

quality = Path("public/src/free-roam-quality-v1.js")
text = quality.read_text(encoding="utf-8")
text = text.replace('free-roam-audio-v5.js?v=43', 'free-roam-audio-v5.js?v=44')
text = text.replace('free-roam-client-prediction.js?v=41', 'free-roam-client-prediction.js?v=42')
old = '''      if (initialRenderPending) {
        initialRenderPending = false;
        api.step(0);
      } else {
        predictLocalWorld(currentWorld, api.playerIndex(), api.input, dt);
      }
      runtimeStats.predictionSteps += 1;'''
new = '''      if (initialRenderPending) {
        initialRenderPending = false;
        api.step(0);
      } else {
        predictLocalWorld(currentWorld, api.playerIndex(), api.input, dt);
      }
      api.localFeedback?.();
      runtimeStats.predictionSteps += 1;'''
if old not in text:
    raise SystemExit("quality prediction loop marker missing")
quality.write_text(text.replace(old, new, 1), encoding="utf-8")

client = Path("public/src/free-roam-v4.js")
text = client.read_text(encoding="utf-8")
old = '''  audioDiagnostics: () => globalThis.__freeRoamAudioDiagnostics || null,
  speechDiagnostics: () => ({'''
new = '''  localFeedback: () => {
    if (world) audio.updateLocalFeedback?.(world, playerIndex, localInput);
  },
  audioDiagnostics: () => globalThis.__freeRoamAudioDiagnostics || null,
  speechDiagnostics: () => ({'''
if old not in text:
    raise SystemExit("client diagnostics marker missing")
client.write_text(text.replace(old, new, 1), encoding="utf-8")

bugfix = Path("tests/free-roam-bugfix-v151.test.mjs")
text = bugfix.read_text(encoding="utf-8")
text = text.replace(r'free-roam-audio-v5\.js\?v=43', r'free-roam-audio-v5\.js\?v=44')
bugfix.write_text(text, encoding="utf-8")

pistol = Path("tests/free-roam-pistol-v41.test.mjs")
text = pistol.read_text(encoding="utf-8")
text = text.replace(r'free-roam-pistol-audio\.js\?v=3', r'free-roam-pistol-audio\.js\?v=4')
pistol.write_text(text, encoding="utf-8")

reconnect = Path("tests/free-roam-target-reconnect-v154.test.mjs")
text = reconnect.read_text(encoding="utf-8")
text = text.replace(r'free-roam-v4\.js\?v=52', r'free-roam-v4\.js\?v=53')
reconnect.write_text(text, encoding="utf-8")
