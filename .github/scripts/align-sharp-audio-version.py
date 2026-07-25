from pathlib import Path

paths = [
    Path("public/src/free-roam-sharp-feedback-v1.js"),
    Path("public/src/free-roam-pistol-audio.js"),
    Path("tests/free-roam-sharp-feedback.test.mjs"),
]

for path in paths:
    text = path.read_text(encoding="utf-8")
    updated = text.replace("free-roam-audio-v5.js?v=44", "free-roam-audio-v5.js?v=45")
    if updated == text:
        continue
    path.write_text(updated, encoding="utf-8")
