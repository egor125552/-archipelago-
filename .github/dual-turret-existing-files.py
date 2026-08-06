from pathlib import Path


def replace(path, old, new):
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old!r}")
    file.write_text(text.replace(old, new))

replace(
    "public/src/free-roam-v4.js",
    'from "./free-roam-core-v6.js?v=47";',
    'from "./free-roam-core-v8.js?v=1";',
)
replace(
    "public/src/free-roam-v4.js",
    'import {applyReplicatedWorldDelta} from "./free-roam-replication.js?v=47";',
    'import {applyReplicatedWorldDelta} from "./free-roam-replication-v2.js?v=1";',
)
replace(
    "public/free-roam.html",
    'src="src/free-roam-v4.js?v=58"',
    'src="src/free-roam-v4.js?v=59"',
)
replace(
    "tests/free-roam-server-authority-v40.test.mjs",
    '} from "../public/src/free-roam-replication.js";',
    '} from "../public/src/free-roam-replication-v2.js";',
)
replace(
    "tests/free-roam-bomb-gesture-v1.test.mjs",
    'assert.match(client, /free-roam-core-v6\\.js\\?v=47/);',
    'assert.match(client, /free-roam-core-v8\\.js\\?v=1/);',
)
replace(
    "tests/free-roam-bomb-gesture-v1.test.mjs",
    'assert.match(html, /free-roam-v4\\.js\\?v=58/);',
    'assert.match(html, /free-roam-v4\\.js\\?v=59/);',
)
