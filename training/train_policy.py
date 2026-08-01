from __future__ import annotations

import argparse
import base64
import json
import math
import os
import random
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from policy_dataset import FEATURE_COUNT, FEATURE_NAMES, MOVEMENT_NAMES, load_episodes, make_sequences, split_episodes, to_replay_episode
from policy_model import TacticalPolicy
from replay_store import load_replay, save_replay


class SequenceDataset(Dataset):
    def __init__(self, examples):
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


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)


def weighted_loss(logits, labels, weights, mask, criterion):
    raw = criterion(logits.reshape(-1, logits.shape[-1]), labels.reshape(-1)).reshape(labels.shape)
    effective = weights * mask
    return (raw * effective).sum() / effective.sum().clamp_min(1.0)


def confusion_counts(truth, prediction, classes):
    matrix = np.zeros((classes, classes), dtype=np.int64)
    for expected, actual in zip(truth, prediction):
        if 0 <= expected < classes and 0 <= actual < classes:
            matrix[expected, actual] += 1
    return matrix


def balanced_accuracy(truth, prediction, classes):
    matrix = confusion_counts(truth, prediction, classes)
    recalls = []
    for index in range(classes):
        total = matrix[index].sum()
        if total:
            recalls.append(matrix[index, index] / total)
    return float(np.mean(recalls)) if recalls else 0.0


def macro_f1(truth, prediction, classes):
    matrix = confusion_counts(truth, prediction, classes)
    scores = []
    for index in range(classes):
        true_positive = matrix[index, index]
        false_positive = matrix[:, index].sum() - true_positive
        false_negative = matrix[index, :].sum() - true_positive
        denominator = 2 * true_positive + false_positive + false_negative
        scores.append((2 * true_positive / denominator) if denominator else 0.0)
    return float(np.mean(scores)) if scores else 0.0


def binary_f1(truth, prediction):
    true_positive = sum(1 for expected, actual in zip(truth, prediction) if expected == 1 and actual == 1)
    false_positive = sum(1 for expected, actual in zip(truth, prediction) if expected == 0 and actual == 1)
    false_negative = sum(1 for expected, actual in zip(truth, prediction) if expected == 1 and actual == 0)
    denominator = 2 * true_positive + false_positive + false_negative
    return float(2 * true_positive / denominator) if denominator else 0.0


def evaluate(model, loader, device):
    model.eval()
    movement_true, movement_pred = [], []
    fire_true, fire_pred = [], []
    losses = []
    movement_criterion = nn.CrossEntropyLoss(reduction="none")
    fire_criterion = nn.CrossEntropyLoss(reduction="none")
    with torch.no_grad():
        for inputs, movement, fire, weights, mask in loader:
            inputs, movement, fire, weights, mask = [item.to(device) for item in (inputs, movement, fire, weights, mask)]
            movement_logits, fire_logits, _ = model(inputs)
            loss = weighted_loss(movement_logits, movement, weights, mask, movement_criterion)
            loss += 0.65 * weighted_loss(fire_logits, fire, weights, mask, fire_criterion)
            losses.append(float(loss.cpu()))
            active = mask.bool()
            movement_true.extend(movement[active].cpu().tolist())
            movement_pred.extend(movement_logits.argmax(-1)[active].cpu().tolist())
            fire_true.extend(fire[active].cpu().tolist())
            fire_pred.extend(fire_logits.argmax(-1)[active].cpu().tolist())
    return {
        "loss": float(np.mean(losses)) if losses else math.inf,
        "movementBalancedAccuracy": balanced_accuracy(movement_true, movement_pred, 5) if movement_true else 0.0,
        "movementMacroF1": macro_f1(movement_true, movement_pred, 5) if movement_true else 0.0,
        "fireBalancedAccuracy": balanced_accuracy(fire_true, fire_pred, 2) if fire_true else 0.0,
        "fireF1": binary_f1(fire_true, fire_pred) if fire_true else 0.0,
        "frames": len(movement_true),
    }


def tensor_list(tensor: torch.Tensor, digits: int = 7):
    return np.round(tensor.detach().cpu().numpy(), digits).tolist()


def quantized_tensor(tensor: torch.Tensor):
    values = tensor.detach().cpu().numpy().astype(np.float32)
    maximum = float(np.max(np.abs(values))) if values.size else 0.0
    scale = maximum / 127.0 if maximum > 1e-12 else 1.0
    quantized = np.clip(np.rint(values / scale), -127, 127).astype(np.int8)
    return {"shape": list(values.shape), "scale": scale, "data": base64.b64encode(quantized.tobytes()).decode("ascii")}


def export_model(model, output_path: Path, report: dict, seed: int):
    state = model.state_dict()
    export = {
        "format": "echo-tactical-gru-int8-v1",
        "version": 1,
        "inputSize": model.input_size,
        "hiddenSize": model.hidden_size,
        "movementClasses": list(MOVEMENT_NAMES),
        "featureNames": list(FEATURE_NAMES),
        "sampleSeconds": 0.2,
        "seed": seed,
        "validation": report["validation"],
        "weights": {
            "gruWeightIH": quantized_tensor(state["gru.weight_ih_l0"]),
            "gruWeightHH": quantized_tensor(state["gru.weight_hh_l0"]),
            "gruBiasIH": quantized_tensor(state["gru.bias_ih_l0"]),
            "gruBiasHH": quantized_tensor(state["gru.bias_hh_l0"]),
            "movementWeight": quantized_tensor(state["movement_head.weight"]),
            "movementBias": quantized_tensor(state["movement_head.bias"]),
            "fireWeight": quantized_tensor(state["fire_head.weight"]),
            "fireBias": quantized_tensor(state["fire_head.bias"]),
        },
    }
    golden_input = torch.linspace(-0.5, 0.5, FEATURE_COUNT).reshape(1, 1, FEATURE_COUNT)
    with torch.no_grad():
        move, fire, hidden = model(golden_input)
    export["golden"] = {
        "input": tensor_list(golden_input[0, 0]),
        "hidden": tensor_list(hidden[0, 0]),
        "movementLogits": tensor_list(move[0, 0]),
        "fireLogits": tensor_list(fire[0, 0]),
        "maximumAbsoluteTolerance": 0.035,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(export, ensure_ascii=False, separators=(",", ":"))
    output_path.write_text(f"export default {payload};\n" if output_path.suffix == ".js" else payload + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", default=[])
    parser.add_argument("--url", action="append", default=[])
    parser.add_argument("--output", default="src/generated/free-roam-tactical-policy-v1.js")
    parser.add_argument("--report", default="training/reports/latest.json")
    parser.add_argument("--replay", default="training/data/replay-v1.npz.b64.json")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--patience", type=int, default=14)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--hidden-size", type=int, default=32)
    parser.add_argument("--sequence-length", type=int, default=32)
    parser.add_argument("--stride", type=int, default=8)
    parser.add_argument("--seed", type=int, default=125552)
    parser.add_argument("--minimum-movement-f1", type=float, default=0.30)
    parser.add_argument("--minimum-fire-f1", type=float, default=0.45)
    args = parser.parse_args()

    seed_everything(args.seed)
    urls = [item for item in args.url if item]
    env_url = os.environ.get("TRAINING_ARCHIVE_URL", "").strip()
    if env_url and env_url not in urls:
        urls.append(env_url)
    incoming = load_episodes(args.input, urls)
    replay_by_id = {item.episode_id: item for item in load_replay(args.replay)}
    for episode in incoming:
        replay_by_id[episode.episode_id] = to_replay_episode(episode)
    episodes = sorted(replay_by_id.values(), key=lambda item: item.started_at)
    if len(episodes) < 3:
        raise SystemExit(f"Need at least 3 unique episodes; found {len(episodes)}")
    save_replay(args.replay, episodes)
    train_episodes, validation_episodes = split_episodes(episodes, args.seed)
    train_examples = make_sequences(train_episodes, args.sequence_length, args.stride, augment_mirror=True)
    validation_examples = make_sequences(validation_episodes, args.sequence_length, args.sequence_length, augment_mirror=False)
    train_loader = DataLoader(SequenceDataset(train_examples), batch_size=args.batch_size, shuffle=True)
    validation_loader = DataLoader(SequenceDataset(validation_examples), batch_size=args.batch_size, shuffle=False)

    device = torch.device("cpu")
    model = TacticalPolicy(FEATURE_COUNT, args.hidden_size).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0025, weight_decay=0.0005)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="min", factor=0.55, patience=4, min_lr=0.00008)
    movement_criterion = nn.CrossEntropyLoss(reduction="none")
    fire_criterion = nn.CrossEntropyLoss(reduction="none")

    best_state = None
    best_score = -math.inf
    best_epoch = 0
    stale = 0
    history = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        losses = []
        for inputs, movement, fire, weights, mask in train_loader:
            inputs, movement, fire, weights, mask = [item.to(device) for item in (inputs, movement, fire, weights, mask)]
            optimizer.zero_grad(set_to_none=True)
            movement_logits, fire_logits, _ = model(inputs)
            loss = weighted_loss(movement_logits, movement, weights, mask, movement_criterion)
            loss += 0.65 * weighted_loss(fire_logits, fire, weights, mask, fire_criterion)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        validation = evaluate(model, validation_loader, device)
        scheduler.step(validation["loss"])
        score = validation["movementMacroF1"] + 0.65 * validation["fireF1"] - 0.02 * validation["loss"]
        history.append({"epoch": epoch, "trainLoss": float(np.mean(losses)), **validation})
        if score > best_score + 1e-5:
            best_score = score
            best_epoch = epoch
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if stale >= args.patience:
            break

    if best_state is None:
        raise SystemExit("Training did not produce a model")
    model.load_state_dict(best_state)
    validation = evaluate(model, validation_loader, device)
    train_metrics = evaluate(model, DataLoader(SequenceDataset(train_examples), batch_size=args.batch_size), device)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    validation_movement = np.concatenate([item.movement[item.mask.astype(bool)] for item in validation_examples])
    validation_fire = np.concatenate([item.fire[item.mask.astype(bool)] for item in validation_examples])
    train_movement = np.concatenate([item.movement[item.mask.astype(bool)] for item in train_examples])
    train_fire = np.concatenate([item.fire[item.mask.astype(bool)] for item in train_examples])
    movement_majority = int(np.bincount(train_movement, minlength=5).argmax())
    fire_majority = int(np.bincount(train_fire, minlength=2).argmax())
    baseline = {
        "movementMajorityClass": MOVEMENT_NAMES[movement_majority],
        "movementMacroF1": macro_f1(validation_movement.tolist(), [movement_majority] * len(validation_movement), 5),
        "fireMajorityClass": fire_majority,
        "fireF1": binary_f1(validation_fire.tolist(), [fire_majority] * len(validation_fire)),
    }
    report = {
        "format": "echo-tactical-training-report-v1",
        "episodes": len(episodes),
        "incomingEpisodes": len(incoming),
        "replayPath": args.replay,
        "trainEpisodes": len(train_episodes),
        "validationEpisodes": len(validation_episodes),
        "trainSequences": len(train_examples),
        "validationSequences": len(validation_examples),
        "featureCount": FEATURE_COUNT,
        "hiddenSize": args.hidden_size,
        "parameterCount": parameter_count,
        "bestEpoch": best_epoch,
        "baseline": baseline,
        "train": train_metrics,
        "validation": validation,
        "history": history,
        "critique": [],
    }
    if train_metrics["movementMacroF1"] - validation["movementMacroF1"] > 0.18:
        report["critique"].append("The train/validation movement gap is large; collect more episodes before enabling control.")
    if validation["movementMacroF1"] < args.minimum_movement_f1:
        report["critique"].append("Movement validation is below the promotion threshold; keep the model in shadow mode.")
    if validation["fireF1"] < args.minimum_fire_f1:
        report["critique"].append("Fire validation is below the promotion threshold; collect more varied firing and ammunition-conservation episodes.")
    if len(validation_episodes) < 2:
        report["critique"].append("Validation contains fewer than two complete battles, so uncertainty is high.")
    if not report["critique"]:
        report["critique"].append("Offline thresholds passed, but simulator head-to-head validation is still required before control is enabled.")
    promoted = validation["movementMacroF1"] >= args.minimum_movement_f1 and validation["fireF1"] >= args.minimum_fire_f1
    report["promotedToShadow"] = promoted

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    export_model(model, Path(args.output), report, args.seed)
    print(json.dumps({"output": args.output, "report": args.report, "validation": validation, "promotedToShadow": promoted}, ensure_ascii=False))
    if not promoted:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
