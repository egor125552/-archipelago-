from pathlib import Path

audio = Path("public/src/free-roam-audio-v5.js")
text = audio.read_text(encoding="utf-8")
old = '''    const frequency = kind === "sonar" ? 610 : kind === "brake" ? 190 : 340;
    this.playSynthPip({frequency, gain: 0.035, duration: 0.045});
    return true;'''
new = '''    const frequency = kind === "sonar" ? 610 : kind === "brake" ? 190 : 340;
    this.playSynthPip({frequency, gain: 0.035, duration: 0.045});
    globalThis.__sonarCueAudit ||= [];
    globalThis.__sonarCueAudit.push({kind, at: performance.now(), audioAt: this.ctx.currentTime});
    return true;'''
if old not in text:
    raise SystemExit("local command cue marker missing")
audio.write_text(text.replace(old, new, 1), encoding="utf-8")
