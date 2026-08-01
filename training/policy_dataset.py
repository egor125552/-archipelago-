from __future__ import annotations

import io
import json
import math
import random
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence

import numpy as np

WORLD_WIDTH = 420.0
WORLD_HEIGHT = 320.0
SAMPLE_SECONDS = 0.2
MOVEMENT_NAMES = ("hold", "approach", "retreat", "flank_left", "flank_right")
FEATURE_NAMES = (
    "alive", "health", "mode_boat", "mode_foot", "mode_swim", "mode_other",
    "x", "y", "heading_sin", "heading_cos", "speed",
    "boundary_left", "boundary_right", "boundary_top", "boundary_bottom",
    "boat_hull", "boat_water", "boat_leak", "boat_fuel",
    "weapon_melee", "weapon_pistol", "weapon_automatic", "ammo",
    "target_local_x", "target_local_y", "target_distance",
    "target_bearing_sin", "target_bearing_cos", "target_health",
    "target_boat", "target_foot", "target_other",
    "active_enemy_count", "near_enemy_count", "heavy_active", "heavy_health",
    "threat_level", "elapsed", "previous_fire", "previous_movement",
)
FEATURE_COUNT = len(FEATURE_NAMES)

MODE_BOAT = 1
MODE_ROOF = 2
MODE_FOOT = 3
MODE_SWIM = 4
MODE_DEAD = 5
WEAPON_MELEE = (0, 1)
WEAPON_PISTOL = 2
WEAPON_AUTOMATIC = 3
ATTACK_BIT = 1 << 9

KILL_EVENT_FRAGMENTS = ("destroy", "elimin", "defeated", "killed", "cleared")
DEATH_EVENT_FRAGMENTS = ("death", "dead", "respawn-start")
DAMAGE_EVENT_FRAGMENTS = ("damage", "hit")
BAD_EVENT_FRAGMENTS = ("shop-denied", "boundary", "ui-deny")


@dataclass(frozen=True)
class Episode:
    episode_id: str
    header: dict
    frames: tuple[dict, ...]
    source: str


@dataclass(frozen=True)
class ReplayEpisode:
    episode_id: str
    level: int
    started_at: int
    outcome: str
    features: np.ndarray
    movement: np.ndarray
    fire: np.ndarray
    weights: np.ndarray


@dataclass
class SequenceExample:
    episode_id: str
    level: int
    features: np.ndarray
    movement: np.ndarray
    fire: np.ndarray
    weights: np.ndarray
    mask: np.ndarray


def _iter_jsonl_members(payload: bytes, source: str) -> Iterator[Episode]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for name in archive.namelist():
            if not name.endswith(".jsonl") or name.startswith("__MACOSX") or "/._" in name:
                continue
            text = archive.read(name).decode("utf-8")
            lines = [line for line in text.splitlines() if line.strip()]
            if len(lines) < 2:
                continue
            header = json.loads(lines[0])
            parsed_frames = []
            for line in lines[1:]:
                item = json.loads(line)
                if item.get("type") == "frame":
                    parsed_frames.append(item)
            frames = tuple(parsed_frames)
            if header.get("type") != "battle" or not frames:
                continue
            yield Episode(str(header.get("id") or name), header, frames, f"{source}:{name}")


def load_episodes(paths: Sequence[str | Path] = (), urls: Sequence[str] = ()) -> list[Episode]:
    by_id: dict[str, Episode] = {}
    for raw_path in paths:
        path = Path(raw_path)
        candidates = sorted(path.glob("*.zip")) if path.is_dir() else [path]
        for candidate in candidates:
            if not candidate.exists() or candidate.suffix.lower() != ".zip":
                continue
            for episode in _iter_jsonl_members(candidate.read_bytes(), str(candidate)):
                by_id[episode.episode_id] = episode
    for url in urls:
        if not url:
            continue
        request = urllib.request.Request(url, headers={"user-agent": "Echo-Archipelago-AI-Trainer/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read()
        for episode in _iter_jsonl_members(payload, url):
            by_id[episode.episode_id] = episode
    return sorted(by_id.values(), key=lambda item: int(item.header.get("startedAt") or 0))


def _active_enemies(frame: dict) -> list[list]:
    enemies = frame.get("enemies") or {}
    result: list[list] = []
    for key in ("pursuers", "boats"):
        for enemy in enemies.get(key) or []:
            if len(enemy) >= 9 and enemy[8]:
                result.append(enemy)
    heavy = enemies.get("heavy")
    if heavy and len(heavy) >= 9 and heavy[8]:
        result.append(heavy)
    for key in ("gunners", "actors"):
        for actor in enemies.get(key) or []:
            if len(actor) >= 11 and actor[10]:
                result.append([actor[0], 8, actor[3], actor[4], actor[5], 0.0, actor[8], actor[2], actor[10]])
    return result


def _player_point(frame: dict, player: list) -> tuple[float, float, float, float, list | None]:
    mode = int(player[3] or 0)
    x, y, heading = float(player[4] or 0), float(player[5] or 0), float(player[6] or 0)
    boat = None
    if mode in (MODE_BOAT, MODE_ROOF):
        for candidate in frame.get("boats") or []:
            if len(candidate) >= 13 and (candidate[2] == player[0] or candidate[1] == player[0]):
                boat = candidate
                break
        if boat:
            x, y, heading = float(boat[3] or x), float(boat[4] or y), float(boat[5] or heading)
            speed = float(boat[6] or 0)
        else:
            speed = 0.0
    else:
        speed = 0.0
    return x, y, heading, speed, boat


def _nearest_enemy(frame: dict, x: float, y: float) -> tuple[list | None, float]:
    best = None
    best_distance = float("inf")
    for enemy in _active_enemies(frame):
        dx = float(enemy[2] or 0) - x
        dy = float(enemy[3] or 0) - y
        metres = math.hypot(dx, dy)
        if metres < best_distance:
            best, best_distance = enemy, metres
    return best, best_distance


def _event_score(frame: dict) -> float:
    score = 0.0
    for event in frame.get("events") or []:
        event_type = str(event.get("type") or "").lower()
        if any(fragment in event_type for fragment in KILL_EVENT_FRAGMENTS):
            score += 1.0
        if any(fragment in event_type for fragment in DEATH_EVENT_FRAGMENTS):
            score -= 1.6
        if any(fragment in event_type for fragment in DAMAGE_EVENT_FRAGMENTS):
            score += 0.15
        if any(fragment in event_type for fragment in BAD_EVENT_FRAGMENTS):
            score -= 0.35
    return score


def _movement_label(frame: dict, future: dict, player_index: int = 0) -> int:
    player = (frame.get("players") or [])[player_index]
    future_player = (future.get("players") or [])[player_index]
    if not player[2] or int(player[3] or 0) == MODE_DEAD:
        return 0
    x, y, _heading, _speed, _boat = _player_point(frame, player)
    fx, fy, _fh, _fs, _fb = _player_point(future, future_player)
    vx, vy = fx - x, fy - y
    speed = math.hypot(vx, vy)
    if speed < 0.35:
        return 0
    enemy, enemy_distance = _nearest_enemy(frame, x, y)
    if not enemy or not math.isfinite(enemy_distance) or enemy_distance < 1e-4:
        return 0
    tx, ty = float(enemy[2] or 0) - x, float(enemy[3] or 0) - y
    inv = 1.0 / enemy_distance
    ux, uy = tx * inv, ty * inv
    radial = vx * ux + vy * uy
    tangential = vx * (-uy) + vy * ux
    if abs(radial) >= abs(tangential) * 1.15:
        return 1 if radial > 0 else 2
    return 3 if tangential > 0 else 4


def _feature_vector(frame: dict, player_index: int, previous_fire: int, previous_movement: int) -> np.ndarray:
    player = (frame.get("players") or [])[player_index]
    alive = bool(player[2]) and int(player[3] or 0) != MODE_DEAD
    mode = int(player[3] or 0)
    x, y, heading, speed, boat = _player_point(frame, player)
    heading_radians = math.radians(heading)
    enemy, enemy_distance = _nearest_enemy(frame, x, y)
    if enemy:
        dx = float(enemy[2] or 0) - x
        dy = float(enemy[3] or 0) - y
        cos_h, sin_h = math.cos(heading_radians), math.sin(heading_radians)
        local_x = dx * cos_h + dy * sin_h
        local_y = -dx * sin_h + dy * cos_h
        bearing = math.atan2(local_x, -local_y)
        enemy_health = max(0.0, float(enemy[6] or 0))
        enemy_role = int(enemy[1] or 0)
    else:
        local_x = local_y = 0.0
        enemy_distance = WORLD_WIDTH
        bearing = 0.0
        enemy_health = 0.0
        enemy_role = 0
    active_enemies = _active_enemies(frame)
    near_count = sum(1 for item in active_enemies if math.hypot(float(item[2] or 0) - x, float(item[3] or 0) - y) <= 40.0)
    heavy = (frame.get("enemies") or {}).get("heavy")
    heavy_active = bool(heavy and len(heavy) >= 9 and heavy[8])
    weapon = int(player[9] or 0)
    ammo = float(player[10] if weapon == WEAPON_AUTOMATIC else player[11] if weapon == WEAPON_PISTOL else 0.0)
    threat = frame.get("threat") or [0]
    elapsed = float(frame.get("t") or 0.0)
    target_mode_boat = 1.0 if enemy_role in (1, 2, 3, 4, 5, 6, 7) else 0.0
    target_mode_foot = 1.0 if enemy_role == 8 else 0.0
    values = [
        float(alive), max(0.0, min(1.0, float(player[7] or 0) / 100.0)),
        float(mode in (MODE_BOAT, MODE_ROOF)), float(mode == MODE_FOOT), float(mode == MODE_SWIM), float(mode not in (MODE_BOAT, MODE_ROOF, MODE_FOOT, MODE_SWIM)),
        x / WORLD_WIDTH, y / WORLD_HEIGHT, math.sin(heading_radians), math.cos(heading_radians), max(-1.0, min(1.0, speed / 22.0)),
        x / WORLD_WIDTH, (WORLD_WIDTH - x) / WORLD_WIDTH, y / WORLD_HEIGHT, (WORLD_HEIGHT - y) / WORLD_HEIGHT,
        max(0.0, min(1.0, float(boat[7] if boat else 100.0) / 100.0)),
        max(0.0, min(1.0, float(boat[8] if boat else 0.0) / 100.0)),
        max(0.0, min(1.0, float(boat[9] if boat else 0.0) / 8.0)),
        max(0.0, min(1.0, float(boat[10] if boat else 0.0) / 100.0)),
        float(weapon in WEAPON_MELEE), float(weapon == WEAPON_PISTOL), float(weapon == WEAPON_AUTOMATIC), max(0.0, min(1.0, ammo / 240.0)),
        max(-1.5, min(1.5, local_x / 160.0)), max(-1.5, min(1.5, local_y / 160.0)), max(0.0, min(2.0, enemy_distance / 160.0)),
        math.sin(bearing), math.cos(bearing), max(0.0, min(2.0, enemy_health / 300.0)),
        target_mode_boat, target_mode_foot, float(not target_mode_boat and not target_mode_foot and enemy is not None),
        min(1.0, len(active_enemies) / 16.0), min(1.0, near_count / 8.0), float(heavy_active), max(0.0, min(2.0, float(heavy[6] if heavy_active else 0.0) / 600.0)),
        max(0.0, min(1.0, float(threat[0] or 0) / 5.0)), max(0.0, min(1.0, elapsed / 360.0)), float(previous_fire), previous_movement / 4.0,
    ]
    vector = np.asarray(values, dtype=np.float32)
    if vector.shape != (FEATURE_COUNT,):
        raise ValueError(f"feature size {vector.shape} != {FEATURE_COUNT}")
    return vector


def episode_arrays(episode: Episode, player_index: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    frames = episode.frames
    features: list[np.ndarray] = []
    movement: list[int] = []
    fire: list[int] = []
    raw_scores = np.asarray([_event_score(frame) for frame in frames], dtype=np.float32)
    future_scores = np.zeros_like(raw_scores)
    for index in range(len(frames)):
        future_scores[index] = raw_scores[index:min(len(frames), index + 11)].sum()
    previous_fire = 0
    previous_movement = 0
    for index, frame in enumerate(frames):
        future = frames[min(len(frames) - 1, index + 2)]
        label = _movement_label(frame, future, player_index)
        mask = int(((frame.get("input") or [[0]])[player_index] or [0])[0] or 0)
        firing = 1 if mask & ATTACK_BIT else 0
        features.append(_feature_vector(frame, player_index, previous_fire, previous_movement))
        movement.append(label)
        fire.append(firing)
        previous_fire = firing
        previous_movement = label
    health = np.asarray([max(0.0, min(100.0, float(frame["players"][player_index][7] or 0))) for frame in frames], dtype=np.float32)
    alive = np.asarray([bool(frame["players"][player_index][2]) for frame in frames], dtype=np.float32)
    weights = np.ones(len(frames), dtype=np.float32)
    weights *= 1.15 if episode.header.get("outcome") == "victory" else 0.8
    weights *= np.clip(0.55 + health / 140.0, 0.35, 1.25)
    weights *= np.where(alive > 0, 1.0, 0.15)
    weights *= np.clip(1.0 + future_scores * 0.22, 0.2, 2.4)
    for index, score in enumerate(raw_scores):
        if score < -1.0:
            weights[max(0, index - 8):index + 1] *= 0.35
    return np.stack(features), np.asarray(movement, dtype=np.int64), np.asarray(fire, dtype=np.int64), weights


def mirror_features(features: np.ndarray, movement: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    result = features.copy()
    idx = {name: i for i, name in enumerate(FEATURE_NAMES)}
    result[:, idx["x"]] = 1.0 - result[:, idx["x"]]
    left = result[:, idx["boundary_left"]].copy()
    result[:, idx["boundary_left"]] = result[:, idx["boundary_right"]]
    result[:, idx["boundary_right"]] = left
    result[:, idx["heading_sin"]] *= -1.0
    result[:, idx["target_local_x"]] *= -1.0
    result[:, idx["target_bearing_sin"]] *= -1.0
    mirrored_movement = movement.copy()
    mirrored_movement[movement == 3] = 4
    mirrored_movement[movement == 4] = 3
    return result, mirrored_movement


def to_replay_episode(episode: Episode) -> ReplayEpisode:
    features, movement, fire, weights = episode_arrays(episode)
    return ReplayEpisode(
        episode_id=episode.episode_id,
        level=_episode_level(episode),
        started_at=int(episode.header.get("startedAt") or 0),
        outcome=str(episode.header.get("outcome") or "unknown"),
        features=features,
        movement=movement,
        fire=fire,
        weights=weights,
    )


def _episode_level(episode: Episode | ReplayEpisode) -> int:
    return episode.level if isinstance(episode, ReplayEpisode) else int(episode.header.get("level") or 0)


def _episode_started_at(episode: Episode | ReplayEpisode) -> int:
    return episode.started_at if isinstance(episode, ReplayEpisode) else int(episode.header.get("startedAt") or 0)


def _episode_arrays(episode: Episode | ReplayEpisode):
    if isinstance(episode, ReplayEpisode):
        return episode.features, episode.movement, episode.fire, episode.weights
    return episode_arrays(episode)


def make_sequences(episodes: Sequence[Episode | ReplayEpisode], sequence_length: int = 32, stride: int = 8, augment_mirror: bool = True) -> list[SequenceExample]:
    examples: list[SequenceExample] = []
    for episode in episodes:
        features, movement, fire, weights = _episode_arrays(episode)
        variants = [(features, movement)]
        if augment_mirror:
            variants.append(mirror_features(features, movement))
        for variant_features, variant_movement in variants:
            starts = [0] if len(variant_features) <= sequence_length else list(range(0, len(variant_features) - sequence_length + 1, stride))
            if len(variant_features) > sequence_length and starts[-1] != len(variant_features) - sequence_length:
                starts.append(len(variant_features) - sequence_length)
            for start in starts:
                end = min(len(variant_features), start + sequence_length)
                count = end - start
                x = np.zeros((sequence_length, FEATURE_COUNT), dtype=np.float32)
                y_movement = np.zeros(sequence_length, dtype=np.int64)
                y_fire = np.zeros(sequence_length, dtype=np.int64)
                y_weight = np.zeros(sequence_length, dtype=np.float32)
                mask = np.zeros(sequence_length, dtype=np.float32)
                x[:count] = variant_features[start:end]
                y_movement[:count] = variant_movement[start:end]
                y_fire[:count] = fire[start:end]
                y_weight[:count] = weights[start:end]
                mask[:count] = 1.0
                examples.append(SequenceExample(episode.episode_id, _episode_level(episode), x, y_movement, y_fire, y_weight, mask))
    return examples


def split_episodes(episodes: Sequence[Episode | ReplayEpisode], seed: int = 125552) -> tuple[list[Episode | ReplayEpisode], list[Episode | ReplayEpisode]]:
    if len(episodes) < 3:
        raise ValueError("At least three unique battles are required for episode-level validation")
    rng = random.Random(seed)
    by_level: dict[int, list[Episode | ReplayEpisode]] = {}
    for episode in episodes:
        by_level.setdefault(_episode_level(episode), []).append(episode)
    validation_ids: set[str] = set()
    for _level, items in sorted(by_level.items()):
        if len(items) >= 2:
            validation_ids.add(sorted(items, key=_episode_started_at)[-1].episode_id)
    if len(validation_ids) < max(1, len(episodes) // 4):
        candidates = [item for item in episodes if item.episode_id not in validation_ids]
        rng.shuffle(candidates)
        validation_ids.update(item.episode_id for item in candidates[:max(1, len(episodes) // 4 - len(validation_ids))])
    train = [item for item in episodes if item.episode_id not in validation_ids]
    validation = [item for item in episodes if item.episode_id in validation_ids]
    if not train or not validation:
        raise ValueError("Unable to create non-empty episode split")
    return train, validation
