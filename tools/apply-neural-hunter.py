from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


path = ROOT / "public/src/game-core-v16.js"
text = path.read_text()
text = replace_once(
    text,
    'import {applyCollisionDamage} from "./collision-model.js";\n',
    'import {applyCollisionDamage} from "./collision-model.js";\n'
    'import {\n'
    '  chooseHunterTactic,\n'
    '  ensureHunterBrain,\n'
    '  hunterTacticalTarget,\n'
    '  hunterTacticLabel,\n'
    '  hunterTacticSpeedScale,\n'
    '  noteHunterDecoy,\n'
    '  noteHunterOutcome,\n'
    '  updateHunterBrainMemory,\n'
    '} from "./hunter-brain.js?v=25.0";\n',
    "hunter brain import",
)

old_modes = '''const HUNTER_MODES = Object.freeze([
  "pursuit", "pursuit", "circle", "pursuit", "patrol",
  "pursuit", "stop", "pursuit", "retreat", "pursuit",
]);
const HUNTER_MODE_SECONDS = Object.freeze({
  pursuit: 5.8,
  circle: 4.2,
  patrol: 4.8,
  stop: 2.4,
  retreat: 3.2,
});
const HUNTER_MODE_LABELS = Object.freeze({
  pursuit: "атакует",
  circle: "кружит",
  patrol: "патрулирует",
  stop: "стоит",
  retreat: "отходит",
  decoy: "идёт к бую",
  disabled: "выведен из строя",
});
'''
text = replace_once(text, old_modes, "", "legacy hunter modes")

old_ensure = '''  if (typeof state.hunter.destroyed !== "boolean") state.hunter.destroyed = state.hunter.hull <= 0;
  if (!HUNTER_MODES.includes(state.hunter.mode)) state.hunter.mode = "pursuit";
  if (!Number.isInteger(state.hunter.modeIndex)) state.hunter.modeIndex = 0;
  if (!Number.isFinite(state.hunter.nextDecisionAt)) {
    state.hunter.nextDecisionAt = CONFIG.hunterSpawnDelay + HUNTER_MODE_SECONDS.pursuit;
  }
'''
new_ensure = '''  if (typeof state.hunter.destroyed !== "boolean") state.hunter.destroyed = state.hunter.hull <= 0;
  const brain = ensureHunterBrain(state);
  state.hunter.mode = brain.tactic;
'''
text = replace_once(text, old_ensure, new_ensure, "hunter state migration")

start = text.index("function hunterTarget(state, now) {")
end = text.index("function steerHunterAroundHazards(state, target) {")
text = text[:start] + '''function hunterTarget(state, now) {
  return hunterTacticalTarget(state, now);
}

''' + text[end:]

text = replace_once(text, '  hunter.mode = "pursuit";\n', '  hunter.mode = "recover";\n  ensureHunterBrain(state).tactic = "recover";\n', "destroyed mode")
text = replace_once(
    text,
    '''    events.push({
      type: "hunter-hit",
      damage: result.damage,
      hunterHull: hunter.hull,
      destroyed: hunter.destroyed,
      playerDamage: selfImpact.damage,
      absorbed: selfImpact.absorbed,
      impactSpeed: relativeSpeed,
      pan,
    });
    return;
''',
    '''    events.push({
      type: "hunter-hit",
      damage: result.damage,
      hunterHull: hunter.hull,
      destroyed: hunter.destroyed,
      playerDamage: selfImpact.damage,
      absorbed: selfImpact.absorbed,
      impactSpeed: relativeSpeed,
      pan,
    });
    noteHunterOutcome(state, "hunter-hit", {damage: result.damage, impactSpeed: relativeSpeed});
    return;
''',
    "hunter led impact feedback",
)
text = replace_once(
    text,
    '''  events.push({
    type: "hunter-ram",
    damage: impact.damage,
    absorbed: impact.absorbed,
    hunterDamage: hunterImpact.damage,
    hunterHull: hunter.hull,
    impactSpeed: relativeSpeed,
    pan,
  });
}

function chooseHunterMode(state, now) {
  const hunter = state.hunter;
  if (hunter.decoyUntil > now || now < hunter.recoverUntil || now < hunter.nextDecisionAt) return;
  hunter.modeIndex = (hunter.modeIndex + 1) % HUNTER_MODES.length;
  hunter.mode = HUNTER_MODES[hunter.modeIndex];
  hunter.nextDecisionAt = now + HUNTER_MODE_SECONDS[hunter.mode];
}
''',
    '''  events.push({
    type: "hunter-ram",
    damage: impact.damage,
    absorbed: impact.absorbed,
    hunterDamage: hunterImpact.damage,
    hunterHull: hunter.hull,
    impactSpeed: relativeSpeed,
    pan,
  });
  noteHunterOutcome(state, "hunter-ram", {damage: impact.damage, impactSpeed: relativeSpeed});
}
''',
    "hunter outcome and legacy chooser",
)

old_update_head = '''  hunter.ramCooldown = Math.max(0, hunter.ramCooldown - dt);
  if (now < CONFIG.hunterSpawnDelay) return;
  chooseHunterMode(state, now);

  const recovering = now < hunter.recoverUntil;
  const playerDistance = distance(hunter, state.boat);
  const forcePursuit = playerDistance > 115 && hunter.decoyUntil <= now;
  let target = forcePursuit ? hunterPursuitTarget(state) : hunterTarget(state, now);
'''
new_update_head = '''  hunter.ramCooldown = Math.max(0, hunter.ramCooldown - dt);
  updateHunterBrainMemory(state, dt, now);
  if (now < CONFIG.hunterSpawnDelay) return;
  const decision = chooseHunterTactic(state, now);
  if (decision.changed) events.push({type: "hunter-tactic", tactic: decision.tactic, confidence: decision.confidence});

  const recovering = now < hunter.recoverUntil;
  const playerDistance = distance(hunter, state.boat);
  let target = hunterTarget(state, now);
'''
text = replace_once(text, old_update_head, new_update_head, "neural hunter update")

old_speeds = '''  let desiredSpeed = Math.min(maxSpeed, 8 + targetDistance * 0.19) * turnFactor;
  if (hunter.mode === "circle") desiredSpeed = Math.min(desiredSpeed, maxSpeed * 0.78);
  if (hunter.mode === "patrol") desiredSpeed = Math.min(desiredSpeed, maxSpeed * 0.62);
  if (hunter.mode === "stop") desiredSpeed = 0;
  if (hunter.mode === "retreat") desiredSpeed = Math.min(desiredSpeed, maxSpeed * 0.7);
  if (forcePursuit && !recovering) desiredSpeed = maxSpeed;
  if (recovering || repositioning) desiredSpeed = 13;
'''
new_speeds = '''  let desiredSpeed = Math.min(maxSpeed, 8 + targetDistance * 0.19) * turnFactor;
  desiredSpeed = Math.min(maxSpeed, desiredSpeed * hunterTacticSpeedScale(hunter.mode));
  if (["intercept", "block-objective", "ignore-decoy"].includes(hunter.mode) && playerDistance > 70) desiredSpeed = maxSpeed;
  if (recovering || repositioning) desiredSpeed = 13;
'''
text = replace_once(text, old_speeds, new_speeds, "neural tactic speeds")

text = replace_once(
    text,
    '''  state.hunter.decoyUntil = clock(state) + 8;
  state.message = "Ложный буй сброшен. Уходи.";
''',
    '''  state.hunter.decoyUntil = clock(state) + 8;
  noteHunterDecoy(state);
  state.message = "Ложный буй сброшен. Уходи: повторный обман преследователь может распознать.";
''',
    "decoy learning",
)

old_view = '''      mode: state.hunter.decoyUntil > now ? "decoy" : state.hunter.destroyed ? "disabled" : state.hunter.mode,
      modeLabel: HUNTER_MODE_LABELS[state.hunter.decoyUntil > now ? "decoy" : state.hunter.destroyed ? "disabled" : state.hunter.mode],
      ramCooldown: state.hunter.ramCooldown,
'''
new_view = '''      mode: state.hunter.destroyed ? "disabled" : state.hunter.mode,
      modeLabel: hunterTacticLabel(state, now),
      neural: {
        tactic: state.hunter.brain?.tactic || "pressure",
        confidence: state.hunter.brain?.confidence || 0,
        turnPersistence: state.hunter.brain?.turnPersistence || 0,
        reversePersistence: state.hunter.brain?.reversePersistence || 0,
        stationaryPersistence: state.hunter.brain?.stationaryPersistence || 0,
        ramBait: state.hunter.brain?.ramBait || 0,
        decoySuspicion: state.hunter.brain?.decoySuspicion || 0,
        failedAttacks: state.hunter.brain?.failedAttacks || 0,
        history: [...(state.hunter.brain?.tacticHistory || [])],
      },
      ramCooldown: state.hunter.ramCooldown,
'''
text = replace_once(text, old_view, new_view, "hunter neural view")
path.write_text(text)

# Force a fresh module chain through the browser cache.
for relative, old, new in [
    ("public/src/game-core-v17.js", '"./game-core-v16.js?base=8"', '"./game-core-v16.js?base=9"'),
    ("public/src/game-core-v18.js", '"./game-core-v17.js?base=8"', '"./game-core-v17.js?base=9"'),
]:
    file_path = ROOT / relative
    source = file_path.read_text()
    source = replace_once(source, old, new, relative)
    file_path.write_text(source)

index = ROOT / "public/index.html"
source = index.read_text().replace("?v=24.0", "?v=25.0")
source = source.replace(
    "Преследователь чаще атакует, но также кружит, патрулирует и отходит. Он получает урон от столкновений; быстрый таран «Громом» может его остановить.",
    "Преследователь анализирует повторяющиеся манёвры небольшой нейросетью: стоянку, задний ход, круги, прямой побег, попытки тарана и повторные ложные буи. Физика и объезд препятствий остаются обычным предсказуемым кодом.",
)
index.write_text(source)

app = ROOT / "public/src/app.js"
app.write_text(app.read_text().replace('progression.js?v=24.0', 'progression.js?v=25.0'))

for name in ["package.json", "package-lock.json"]:
    file_path = ROOT / name
    source = file_path.read_text().replace('"version": "0.8.4"', '"version": "0.9.0"')
    file_path.write_text(source)

lab = ROOT / "public/hunter-lab.html"
lab.write_text('''<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Hunter neural laboratory</title></head>
<body><main><h1>Hunter neural laboratory</h1><pre id="report">ready</pre></main>
<script type="module">
import {trainVirtualHunter} from "./src/hunter-virtual-players.js?v=25.0";
window.__hunterLab = {
  train(options) {
    const result = trainVirtualHunter(options);
    document.querySelector("#report").textContent = JSON.stringify(result.report, null, 2);
    return result;
  },
};
</script></body></html>''')

print("Neural hunter integration applied")
