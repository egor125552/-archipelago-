from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
core = ROOT / "public/src/game-core-v16.js"
text = core.read_text()

old = '''    const sameLockedHazard = avoidance.hazardId === hazard.id
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
    }'''

new = '''    const committedSide = avoidance.side !== 0 && now < avoidance.lockedUntil;
    const committed = committedSide
      ? avoidanceCandidateCost(state, hazard, target, avoidance.side, ux, uy)
      : null;
    const alternative = committedSide
      ? avoidanceCandidateCost(state, hazard, target, -avoidance.side, ux, uy)
      : null;
    const committedImpossible = committed && alternative && committed.cost > alternative.cost + 180;

    if (!committedSide || committedImpossible) {
      const left = avoidanceCandidateCost(state, hazard, target, -1, ux, uy);
      const right = avoidanceCandidateCost(state, hazard, target, 1, ux, uy);
      const selected = left.cost <= right.cost ? {side: -1, ...left} : {side: 1, ...right};
      if (avoidance.side && avoidance.side !== selected.side) {
        avoidance.sideChanges += 1;
        avoidance.lastSideChangeAt = now;
      }
      avoidance.hazardId = hazard.id;
      avoidance.side = selected.side;
      avoidance.lockedUntil = now + 3.4;
      avoidance.waypointX = selected.waypoint.x;
      avoidance.waypointY = selected.waypoint.y;
    } else {
      // Keep one side for the whole connected wreck cluster. A new blocking
      // object updates the waypoint, but does not restart left/right roulette.
      avoidance.hazardId = hazard.id;
      avoidance.waypointX = committed.waypoint.x;
      avoidance.waypointY = committed.waypoint.y;
      avoidance.lockedUntil = Math.max(avoidance.lockedUntil, now + 1.15);
    }'''

count = text.count(old)
if count != 1:
    raise RuntimeError(f"cluster commitment block: expected one match, found {count}")
core.write_text(text.replace(old, new, 1))

for relative in ["public/index.html", "public/src/app.js", "public/src/hunter-brain.js"]:
    path = ROOT / relative
    path.write_text(path.read_text().replace("v=26.0", "v=27.0"))

for relative in ["public/src/game-core-v17.js", "public/src/game-core-v18.js"]:
    path = ROOT / relative
    path.write_text(path.read_text().replace("?base=10", "?base=11"))

print("Applied cluster-wide hunter side commitment and cache generation 27")
