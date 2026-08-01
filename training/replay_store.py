from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from typing import Sequence

import numpy as np

from policy_dataset import FEATURE_COUNT, ReplayEpisode

FORMAT = "echo-tactical-replay-v1"
FEATURE_SCALE = 8192.0
WEIGHT_SCALE = 64.0
CHUNK_CHARACTERS = 7_000


def _part_name(path: Path, index: int) -> str:
    return f"{path.stem}.part-{index:03d}.b64"


def save_replay(path: str | Path, episodes: Sequence[ReplayEpisode]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    arrays: dict[str, np.ndarray] = {}
    metadata = []
    for index, episode in enumerate(sorted(episodes, key=lambda item: item.started_at)):
        prefix = f"e{index}"
        arrays[f"{prefix}_x"] = np.clip(np.rint(episode.features * FEATURE_SCALE), -32767, 32767).astype(np.int16)
        arrays[f"{prefix}_m"] = episode.movement.astype(np.uint8)
        arrays[f"{prefix}_f"] = episode.fire.astype(np.uint8)
        arrays[f"{prefix}_w"] = np.clip(np.rint(episode.weights * WEIGHT_SCALE), 0, 255).astype(np.uint8)
        metadata.append({
            "prefix": prefix,
            "id": episode.episode_id,
            "level": episode.level,
            "startedAt": episode.started_at,
            "outcome": episode.outcome,
            "frames": int(len(episode.features)),
        })
    arrays["metadata"] = np.frombuffer(json.dumps({"format": FORMAT, "episodes": metadata}, separators=(",", ":")).encode("utf-8"), dtype=np.uint8)
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **arrays)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    chunks = [encoded[offset:offset + CHUNK_CHARACTERS] for offset in range(0, len(encoded), CHUNK_CHARACTERS)] or [""]
    chunk_names = []
    for index, chunk in enumerate(chunks):
        name = _part_name(path, index)
        (path.parent / name).write_text(chunk + "\n", encoding="ascii")
        chunk_names.append(name)
    for stale in path.parent.glob(f"{path.stem}.part-*.b64"):
        if stale.name not in chunk_names:
            stale.unlink()
    wrapper = {
        "format": FORMAT,
        "encoding": "base64-npz-chunks",
        "featureScale": FEATURE_SCALE,
        "weightScale": WEIGHT_SCALE,
        "episodeCount": len(metadata),
        "chunks": chunk_names,
    }
    path.write_text(json.dumps(wrapper, separators=(",", ":")) + "\n", encoding="utf-8")


def load_replay(path: str | Path) -> list[ReplayEpisode]:
    path = Path(path)
    if not path.exists():
        return []
    wrapper = json.loads(path.read_text(encoding="utf-8"))
    if wrapper.get("format") != FORMAT:
        raise ValueError("Unsupported tactical replay format")
    encoding = wrapper.get("encoding")
    if encoding == "base64-npz":
        encoded = str(wrapper.get("data") or "")
    elif encoding == "base64-npz-chunks":
        names = wrapper.get("chunks") or []
        if not names:
            raise ValueError("Tactical replay manifest has no chunks")
        encoded = "".join((path.parent / str(name)).read_text(encoding="ascii").strip() for name in names)
    else:
        raise ValueError("Unsupported tactical replay encoding")
    payload = base64.b64decode(encoded)
    archive = np.load(io.BytesIO(payload), allow_pickle=False)
    metadata = json.loads(archive["metadata"].tobytes().decode("utf-8"))
    result = []
    for item in metadata.get("episodes") or []:
        prefix = item["prefix"]
        features = archive[f"{prefix}_x"].astype(np.float32) / float(wrapper.get("featureScale") or FEATURE_SCALE)
        if features.ndim != 2 or features.shape[1] != FEATURE_COUNT:
            raise ValueError(f"Replay {item.get('id')} has invalid feature shape {features.shape}")
        result.append(ReplayEpisode(
            episode_id=str(item["id"]),
            level=int(item.get("level") or 0),
            started_at=int(item.get("startedAt") or 0),
            outcome=str(item.get("outcome") or "unknown"),
            features=features,
            movement=archive[f"{prefix}_m"].astype(np.int64),
            fire=archive[f"{prefix}_f"].astype(np.int64),
            weights=archive[f"{prefix}_w"].astype(np.float32) / float(wrapper.get("weightScale") or WEIGHT_SCALE),
        ))
    return result
