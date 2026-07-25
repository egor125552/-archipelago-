from pathlib import Path

path = Path('/tmp/apply-local-action-prediction.py')
text = path.read_text(encoding='utf-8')
text = text.replace(
    "replace_once(html, 'free-roam-v4.js?v=53', 'free-roam-v4.js?v=54')",
    "replace_once(html, 'free-roam-v4.js?v=54', 'free-roam-v4.js?v=55')",
)
text = text.replace(
    "replace_all(path, r'free-roam-v4\\.js\\?v=53', r'free-roam-v4\\.js\\?v=54')",
    "replace_all(path, r'free-roam-v4\\.js\\?v=54', r'free-roam-v4\\.js\\?v=55')",
)
path.write_text(text, encoding='utf-8')
