from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1))


core = ROOT / "public/src/game-core-v16.js"

replace_once(
    core,
    '  if (typeof state.hunter.destroyed !== "boolean") state.hunter.destroyed = state.hunter.hull <= 0;\n  const brain = ensureHunterBrain(state);',
    '''  if (typeof state.hunter.destroyed !== "boolean") state.hunter.destroyed = state.hunter.hull <= 0;
  state.hunter.avoidance ||= {};
  const avoidance = state.hunter.avoidance;
  if (avoidance.version !== 1) {
    Object.assign(avoidance, {
      version: 1,
      hazardId: null,
      side: 0,
      lockedUntil: 0,
      waypointX: 0,
      waypointY: 0,
      blocked: false,
      sideChanges: 0,
      lastSideChangeAt: 0,
    });
  }
  const brain = ensureHunterBrain(state);''',
    "hunter avoidance state",
)

old_steer = '''function steerHunterAroundHazards(state, target) {
  let dx = target.x - state.hunter.x;
  let dy = target.y - state.hunter.y;
  const baseLength = Math.hypot(dx, dy) || 1;
  dx /= baseLength;
  dy /= baseLength;
  for (const hazard of state.world.hazards) {
    const hx = state.hunter.x - hazard.x;
    const hy = state.hunter.y - hazard.y;
    const metres = Math.hypot(hx, hy) || 1;
    const influence = hazard.radius + 22;
    if (metres >= influence) continue;
    const toward = dx * (hazard.x - state.hunter.x) + dy * (hazard.y - state.hunter.y);
    if (toward < -2) continue;
    const strength = Math.pow((influence - metres) / influence, 1.35) * 3.2;
    dx += hx / metres * strength;
    dy += hy / metres * strength;
  }
  const bounds = state.world.bounds;
  const margin = 18;
  if (state.hunter.x < bounds.minX + margin) dx += 2;
  if (state.hunter.x > bounds.maxX - margin) dx -= 2;
  if (state.hunter.y < bounds.minY + margin) dy += 2;
  if (state.hunter.y > bounds.maxY - margin) dy -= 2;
  return deg(Math.atan2(dx, dy));
}'''

new_steer = '''function segmentHazardBlock(state, target) {
  const start = state.hunter;
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  let best = null;
  for (const hazard of state.world.hazards) {
    const hx = hazard.x - start.x;
    const hy = hazard.y - start.y;
    const along = hx * ux + hy * uy;
    if (along < -2 || along > length + 8) continue;
    const lateral = Math.abs(hx * uy - hy * ux);
    const clearance = hazard.radius + 10.5;
    if (lateral >= clearance) continue;
    const entry = along - Math.sqrt(Math.max(0, clearance * clearance - lateral * lateral));
    if (!best || entry < best.entry) best = {hazard, entry, along, ux, uy, length};
  }
  return best;
}

function avoidanceCandidateCost(state, hazard, target, side, ux, uy) {
  const clearance = hazard.radius + 17;
  const sideX = -uy * side;
  const sideY = ux * side;
  const waypoint = {
    x: hazard.x + sideX * clearance + ux * 7,
    y: hazard.y + sideY * clearance + uy * 7,
  };
  let cost = distance(state.hunter, waypoint) + distance(waypoint, target) * 0.72;
  for (const other of state.world.hazards) {
    if (other.id === hazard.id) continue;
    const metres = distance(waypoint, other);
    const safe = other.radius + 10;
    if (metres < safe) cost += (safe - metres) * 14;
  }
  const bounds = state.world.bounds;
  if (waypoint.x < bounds.minX + 15 || waypoint.x > bounds.maxX - 15) cost += 180;
  if (waypoint.y < bounds.minY + 15 || waypoint.y > bounds.maxY - 15) cost += 180;
  return {cost, waypoint};
}

function steerHunterAroundHazards(state, target, now) {
  const avoidance = state.hunter.avoidance;
  const block = segmentHazardBlock(state, target);
  let navigationTarget = target;

  if (block) {
    const {hazard, ux, uy} = block;
    const sameLockedHazard = avoidance.hazardId === hazard.id
      && avoidance.side !== 0
      && now < avoidance.lockedUntil;
    if (!sameLockedHazard) {
      const left = avoidanceCandidateCost(state, hazard, target, -1, ux, uy);
      const right = avoidanceCandidateCost(state, hazard, target, 1, ux, uy);
      const selected = left.cost <= right.cost ? {side: -1, ...left} : {side: 1, ...right};
      if (avoidance.side && avoidance.side !== selected.side) {
        avoidance.sideChanges += 1;
        avoidance.lastSideChangeAt = now;
      }
      avoidance.hazardId = hazard.id;
      avoidance.side = selected.side;
      avoidance.lockedUntil = now + 2.8;
      avoidance.waypointX = selected.waypoint.x;
      avoidance.waypointY = selected.waypoint.y;
    } else {
      const selected = avoidanceCandidateCost(state, hazard, target, avoidance.side, ux, uy);
      avoidance.waypointX = selected.waypoint.x;
      avoidance.waypointY = selected.waypoint.y;
    }
    avoidance.blocked = true;
    navigationTarget = {x: avoidance.waypointX, y: avoidance.waypointY};
  } else {
    avoidance.blocked = false;
    if (now >= avoidance.lockedUntil) {
      avoidance.hazardId = null;
      avoidance.side = 0;
    }
  }

  let dx = navigationTarget.x - state.hunter.x;
  let dy = navigationTarget.y - state.hunter.y;
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;

  // Keep only a weak local separation force. The locked waypoint owns the
  // side choice, so several nearby wrecks cannot flip it every frame.
  for (const hazard of state.world.hazards) {
    const hx = state.hunter.x - hazard.x;
    const hy = state.hunter.y - hazard.y;
    const metres = Math.hypot(hx, hy) || 1;
    const influence = hazard.radius + 11;
    if (metres >= influence) continue;
    const strength = Math.pow((influence - metres) / influence, 1.4) * 0.9;
    dx += hx / metres * strength;
    dy += hy / metres * strength;
  }

  const bounds = state.world.bounds;
  const margin = 18;
  if (state.hunter.x < bounds.minX + margin) dx += 2;
  if (state.hunter.x > bounds.maxX - margin) dx -= 2;
  if (state.hunter.y < bounds.minY + margin) dy += 2;
  if (state.hunter.y > bounds.maxY - margin) dy -= 2;
  return deg(Math.atan2(dx, dy));
}'''

replace_once(core, old_steer, new_steer, "stateful hunter obstacle steering")
replace_once(
    core,
    "  const desiredHeading = steerHunterAroundHazards(state, target);",
    "  const desiredHeading = steerHunterAroundHazards(state, target, now);",
    "pass hunter clock to avoidance",
)

for relative in [
    "public/index.html",
    "public/src/app.js",
    "public/src/hunter-brain.js",
]:
    path = ROOT / relative
    path.write_text(path.read_text().replace("v=25.0", "v=26.0"))

for relative in ["public/src/game-core-v17.js", "public/src/game-core-v18.js"]:
    path = ROOT / relative
    path.write_text(path.read_text().replace("?base=9", "?base=10"))

print("Applied stateful hunter obstacle navigation and cache generation 26")
