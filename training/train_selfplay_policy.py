from __future__ import annotations

import argparse
import base64
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from policy_dataset import FEATURE_COUNT
from policy_model import TacticalPolicy
from train_policy import export_model, seed_everything


@dataclass
class Example:
    episode_id: str
    features: np.ndarray
    movement: np.ndarray
    fire: np.ndarray
    weights: np.ndarray
    mask: np.ndarray


class SequenceDataset(Dataset):
    def __init__(self, examples: list[Example]):
        self.examples = examples

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, index):
        item = self.examples[index]
        return (
            torch.from_numpy(item.features),
            torch.from_numpy(item.movement),
            torch.from_numpy(item.fire),
            torch.from_numpy(item.weights),
            torch.from_numpy(item.mask),
        )


def parse_export(path: Path) -> dict:
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("export default"):
        text = text[len("export default"):].strip()
    if text.endswith(";"):
        text = text[:-1]
    return json.loads(text)


def dequantize(item: dict) -> torch.Tensor:
    raw = np.frombuffer(base64.b64decode(item["data"]), dtype=np.int8).astype(np.float32)
    values = raw * float(item.get("scale") or 1.0)
    return torch.from_numpy(values.reshape(item["shape"]))


def load_base_model(path: Path) -> tuple[TacticalPolicy, dict]:
    payload = parse_export(path)
    if int(payload.get("inputSize") or 0) != FEATURE_COUNT:
        raise ValueError(f"base model input size {payload.get('inputSize')} != {FEATURE_COUNT}")
    model = TacticalPolicy(FEATURE_COUNT, int(payload.get("hiddenSize") or 32))
    weights = payload["weights"]
    state = {
        "gru.weight_ih_l0": dequantize(weights["gruWeightIH"]),
        "gru.weight_hh_l0": dequantize(weights["gruWeightHH"]),
        "gru.bias_ih_l0": dequantize(weights["gruBiasIH"]),
        "gru.bias_hh_l0": dequantize(weights["gruBiasHH"]),
        "movement_head.weight": dequantize(weights["movementWeight"]),
        "movement_head.bias": dequantize(weights["movementBias"]),
        "fire_head.weight": dequantize(weights["fireWeight"]),
        "fire_head.bias": dequantize(weights["fireBias"]),
    }
    model.load_state_dict(state)
    return model, payload


def json_files(inputs: list[str]) -> list[Path]:
    result: list[Path] = []
    for raw in inputs:
        path = Path(raw)
        if path.is_dir():
            result.extend(sorted(path.rglob("*.json")))
        elif path.exists():
            result.append(path)
    return result


def load_elites(inputs: list[str]) -> list[dict]:
    by_id: dict[str, dict] = {}
    for path in json_files(inputs):
        parsed = json.loads(path.read_text(encoding="utf-8"))
        for episode in parsed.get("eliteEpisodes") or []:
            by_id[str(episode.get("id") or f"{path}:{len(by_id)}")] = episode
    return sorted(by_id.values(), key=lambda item: (int(item.get("level") or 0), -float(item.get("score") or 0)))


def make_examples(episodes: list[dict], sequence_length: int, stride: int) -> list[Example]:
    if not episodes:
        return []
    scores = np.asarray([float(item.get("score") or 0) for item in episodes], dtype=np.float32)
    minimum, maximum = float(scores.min()), float(scores.max())
    scale = max(1e-6, maximum - minimum)
    examples: list[Example] = []
    for episode in episodes:
        normalized_score = (float(episode.get("score") or 0) - minimum) / scale
        episode_weight = 0.55 + normalized_score * 1.45
        outcome = str(episode.get("outcome") or "timeout")
        if outcome == "team-wipe":
            episode_weight *= 1.2
        elif outcome == "timeout":
            episode_weight *= 0.65
        for actor in episode.get("actors") or []:
            samples = actor.get("samples") or []
            if len(samples) < 4:
                continue
            features = np.asarray([item["f"] for item in samples], dtype=np.float32)
            movement = np.asarray([int(item.get("m") or 0) for item in samples], dtype=np.int64)
            fire = np.asarray([int(item.get("fire") or 0) for item in samples], dtype=np.int64)
            explored = np.asarray([
                1.0 if int(item.get("em") or 0) or int(item.get("ef") or 0) else 0.0
                for item in samples
            ], dtype=np.float32)
            weights = np.full(len(samples), episode_weight * 0.38, dtype=np.float32)
            weights += explored * episode_weight * 1.25
            if str(actor.get("role") or "") == "heavy_turret":
                weights *= 1.2
            starts = [0] if len(samples) <= sequence_length else list(range(0, len(samples) - sequence_length + 1, stride))
            if len(samples) > sequence_length and starts[-1] != len(samples) - sequence_length:
                starts.append(len(samples) - sequence_length)
            for start in starts:
                end = min(len(samples), start + sequence_length)
                count = end - start
                x = np.zeros((sequence_length, FEATURE_COUNT), dtype=np.float32)
                y_move = np.zeros(sequence_length, dtype=np.int64)
                y_fire = np.zeros(sequence_length, dtype=np.int64)
                y_weight = np.zeros(sequence_length, dtype=np.float32)
                mask = np.zeros(sequence_length, dtype=np.float32)
                x[:count] = features[start:end]
                y_move[:count] = movement[start:end]
                y_fire[:count] = fire[start:end]
                y_weight[:count] = weights[start:end]
                mask[:count] = 1.0
                examples.append(Example(str(episode.get("id")), x, y_move, y_fire, y_weight, mask))
    return examples


def split_examples(examples: list[Example], seed: int) -> tuple[list[Example], list[Example]]:
    episode_ids = sorted({item.episode_id for item in examples})
    random.Random(seed).shuffle(episode_ids)
    validation_count = max(1, len(episode_ids) // 5)
    validation_ids = set(episode_ids[:validation_count])
    train = [item for item in examples if item.episode_id not in validation_ids]
    validation = [item for item in examples if item.episode_id in validation_ids]
    if not train or not validation:
        raise ValueError("self-play split requires at least two distinct elite episodes")
    return train, validation


def weighted_loss(logits, labels, weights, mask, criterion):
    raw = criterion(logits.reshape(-1, logits.shape[-1]), labels.reshape(-1)).reshape(labels.shape)
    effective = weights * mask
    return (raw * effective).sum() / effective.sum().clamp_min(1.0)


def evaluate(model, loader):
    model.eval()
    losses = []
    move_correct = move_total = fire_correct = fire_total = 0
    move_criterion = nn.CrossEntropyLoss(reduction="none")
    fire_criterion = nn.CrossEntropyLoss(reduction="none")
    with torch.no_grad():
        for inputs, movement, fire, weights, mask in loader:
            move_logits, fire_logits, _ = model(inputs)
            loss = weighted_loss(move_logits, movement, weights, mask, move_criterion)
            loss += 0.65 * weighted_loss(fire_logits, fire, weights, mask, fire_criterion)
            losses.append(float(loss))
            active = mask.bool()
            move_correct += int((move_logits.argmax(-1)[active] == movement[active]).sum())
            move_total += int(active.sum())
            fire_correct += int((fire_logits.argmax(-1)[active] == fire[active]).sum())
            fire_total += int(active.sum())
    return {
        "loss": float(np.mean(losses)) if losses else math.inf,
        "movementAccuracy": move_correct / max(1, move_total),
        "fireAccuracy": fire_correct / max(1, fire_total),
        "frames": move_total,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", default=[])
    parser.add_argument("--base-model", default="src/generated/free-roam-tactical-policy-v1.js")
    parser.add_argument("--output", default="training/reports/selfplay-candidate-policy.js")
    parser.add_argument("--report", default="training/reports/selfplay-training.json")
    parser.add_argument("--epochs", type=int, default=28)
    parser.add_argument("--patience", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--sequence-length", type=int, default=32)
    parser.add_argument("--stride", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=0.00055)
    parser.add_argument("--anchor", type=float, default=0.018)
    parser.add_argument("--seed", type=int, default=125552)
    args = parser.parse_args()

    seed_everything(args.seed)
    episodes = load_elites(args.input)
    if len(episodes) < 8:
        raise SystemExit(f"Need at least 8 elite episodes; found {len(episodes)}")
    examples = make_examples(episodes, args.sequence_length, args.stride)
    train_examples, validation_examples = split_examples(examples, args.seed)
    train_loader = DataLoader(SequenceDataset(train_examples), batch_size=args.batch_size, shuffle=True)
    validation_loader = DataLoader(SequenceDataset(validation_examples), batch_size=args.batch_size)

    model, base_payload = load_base_model(Path(args.base_model))
    base_state = {name: value.detach().clone() for name, value in model.state_dict().items()}
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=0.0004)
    move_criterion = nn.CrossEntropyLoss(reduction="none")
    fire_criterion = nn.CrossEntropyLoss(reduction="none")
    best_state = None
    best_loss = math.inf
    stale = 0
    history = []

    for epoch in range(1, args.epochs + 1):
        model.train()
        losses = []
        for inputs, movement, fire, weights, mask in train_loader:
            optimizer.zero_grad(set_to_none=True)
            move_logits, fire_logits, _ = model(inputs)
            loss = weighted_loss(move_logits, movement, weights, mask, move_criterion)
            loss += 0.65 * weighted_loss(fire_logits, fire, weights, mask, fire_criterion)
            anchor_loss = sum((parameter - base_state[name]).pow(2).mean() for name, parameter in model.named_parameters())
            loss += args.anchor * anchor_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 0.8)
            optimizer.step()
            losses.append(float(loss.detach()))
        validation = evaluate(model, validation_loader)
        history.append({"epoch": epoch, "trainLoss": float(np.mean(losses)), **validation})
        if validation["loss"] < best_loss - 1e-5:
            best_loss = validation["loss"]
            best_state = {name: value.detach().clone() for name, value in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if stale >= args.patience:
            break

    if best_state is None:
        raise SystemExit("Self-play fine-tuning did not produce a candidate")
    model.load_state_dict(best_state)
    validation = evaluate(model, validation_loader)
    train_metrics = evaluate(model, DataLoader(SequenceDataset(train_examples), batch_size=args.batch_size))
    drift = math.sqrt(sum(float((model.state_dict()[name] - base_state[name]).pow(2).sum()) for name in base_state))
    report = {
        "format": "echo-neural-selfplay-training-v1",
        "baseModelVersion": base_payload.get("version"),
        "episodes": len(episodes),
        "actors": sum(len(item.get("actors") or []) for item in episodes),
        "trainSequences": len(train_examples),
        "validationSequences": len(validation_examples),
        "bestValidationLoss": best_loss,
        "parameterL2Drift": drift,
        "train": train_metrics,
        "validation": validation,
        "history": history,
        "critique": [
            "The candidate learns from elite explored trajectories, not from a mathematically exact policy-gradient objective.",
            "Validation accuracy measures imitation of held-out elite actions, not combat quality.",
            "The base-weight anchor limits catastrophic drift but can also prevent a necessary large improvement.",
            "Promotion is forbidden until the candidate beats the base model on held-out authoritative server episodes without worse water or timeout metrics.",
        ],
    }
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    export_model(model, Path(args.output), {"validation": validation}, args.seed)
    print(json.dumps({"output": args.output, "episodes": len(episodes), "validation": validation, "drift": drift}))


if __name__ == "__main__":
    main()
