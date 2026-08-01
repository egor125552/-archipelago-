from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default="training/reports/latest.json")
    parser.add_argument("--model", default="src/generated/free-roam-tactical-policy-v1.js")
    parser.add_argument("--output", default="training/reports/latest-review.md")
    args = parser.parse_args()

    report_path = Path(args.report)
    model_path = Path(args.model)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    validation = report["validation"]
    train = report["train"]
    baseline = report["baseline"]
    validation_episode_count = int(report.get("validationEpisodes") or 0)
    checks = [
        (report["parameterCount"] <= 15_000, f"Параметры: {report['parameterCount']} из 15 000"),
        (model_path.stat().st_size <= 32_000, f"Размер модели: {model_path.stat().st_size} байт из 32 000"),
        (validation_episode_count >= 2, f"Отложенных целых боёв: {validation_episode_count}, требуется минимум 2"),
        (validation["movementMacroF1"] >= baseline["movementMacroF1"] + 0.20, f"Движение F1: {validation['movementMacroF1']:.3f}, baseline {baseline['movementMacroF1']:.3f}"),
        (validation["fireF1"] >= baseline["fireF1"] + 0.35, f"Стрельба F1: {validation['fireF1']:.3f}, baseline {baseline['fireF1']:.3f}"),
        (train["movementMacroF1"] - validation["movementMacroF1"] <= 0.18, f"Разрыв train/validation движения: {train['movementMacroF1'] - validation['movementMacroF1']:.3f}, максимум 0.180"),
        (validation["movementMacroF1"] >= 0.30, f"Минимальный movement macro-F1: {validation['movementMacroF1']:.3f}"),
        (validation["fireF1"] >= 0.45, f"Минимальный fire F1: {validation['fireF1']:.3f}"),
    ]
    passed = all(ok for ok, _ in checks)
    lines = [
        "# Самокритика тактической нейросети",
        "",
        f"**Результат:** {'ПРОШЛА ТЕНЕВОЙ ДОПУСК' if passed else 'ОТКЛОНЕНА'}",
        "",
        "Модель пока не управляет врагами. Допуск означает только право работать параллельно старому ИИ и собирать сравнения.",
        "",
        "## Проверки",
        "",
    ]
    for ok, description in checks:
        lines.append(f"- {'✅' if ok else '❌'} {description}")
    lines.extend(["", "## Остаточные риски", ""])
    for critique in report.get("critique") or []:
        lines.append(f"- {critique}")
    lines.extend([
        "- Данные получены в основном от одного игрока, поэтому стиль может быть слишком персональным.",
        "- Победа в офлайн-классификации не равна победе в симуляторе.",
        "- До включения управления нужны A/B-прогоны одинаковых seed против старого ИИ.",
        "",
    ])
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    if not passed:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
