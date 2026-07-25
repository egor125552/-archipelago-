from pathlib import Path

server = Path("src/free-roam-server.js")
text = server.read_text(encoding="utf-8")
old = "  const world = createFreeWorld();\n"
new = '''  const world = createFreeWorld();
  const auditCombat = world.players?.[0]?.combat;
  if (auditCombat) {
    auditCombat.weapons ||= {};
    auditCombat.weapons.automatic = true;
    auditCombat.equipped = "automatic";
    auditCombat.ammo = 200;
  }
'''
if old not in text:
    raise SystemExit("server world marker missing")
server.write_text(text.replace(old, new, 1), encoding="utf-8")

audio = Path("public/src/free-roam-audio-v5.js")
text = audio.read_text(encoding="utf-8")
old = "        if (played) this.localMovementSuppressUntil = now + 1.25;\n"
new = '''        if (played) {
          this.localMovementSuppressUntil = now + 1.25;
          globalThis.__localFeedbackAudit ||= {steps: [], shots: [], commands: []};
          globalThis.__localFeedbackAudit.steps.push({at: performance.now(), audioAt: now, mode: player.mode});
        }
'''
if old not in text:
    raise SystemExit("local movement marker missing")
text = text.replace(old, new, 1)
old = '''    this.play("automaticShot", {
      pan: 0,
      gain: COMBAT_TUNING.automaticShotGain,
      rate: 0.98 + Math.random() * 0.04,
      lowpass: 12000,
    });
    this.localFireBudget -= 1;'''
new = '''    this.play("automaticShot", {
      pan: 0,
      gain: COMBAT_TUNING.automaticShotGain,
      rate: 0.98 + Math.random() * 0.04,
      lowpass: 12000,
    });
    globalThis.__localFeedbackAudit ||= {steps: [], shots: [], commands: []};
    globalThis.__localFeedbackAudit.shots.push({at: performance.now(), audioAt: now});
    this.localFireBudget -= 1;'''
if old not in text:
    raise SystemExit("local automatic marker missing")
text = text.replace(old, new, 1)
old = '''    const frequency = kind === "sonar" ? 610 : kind === "brake" ? 190 : 340;
    this.playSynthPip({frequency, gain: 0.035, duration: 0.045});
    return true;'''
new = '''    const frequency = kind === "sonar" ? 610 : kind === "brake" ? 190 : 340;
    this.playSynthPip({frequency, gain: 0.035, duration: 0.045});
    globalThis.__localFeedbackAudit ||= {steps: [], shots: [], commands: []};
    globalThis.__localFeedbackAudit.commands.push({at: performance.now(), audioAt: this.ctx.currentTime, kind});
    return true;'''
if old not in text:
    raise SystemExit("local command marker missing")
audio.write_text(text.replace(old, new, 1), encoding="utf-8")
