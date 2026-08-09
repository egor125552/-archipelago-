import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";

const guardUrl = new URL("../public/src/free-roam-keyboard-edge-guard-v1.js", import.meta.url);
const htmlUrl = new URL("../public/free-roam.html", import.meta.url);

function fakeKeyboardRealm() {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const add = (map, type, listener) => {
    const list = map.get(type) || [];
    list.push(listener);
    map.set(type, list);
  };
  const document = {
    hidden: false,
    addEventListener(type, listener) { add(documentListeners, type, listener); },
  };
  const context = {
    document,
    addEventListener(type, listener) { add(windowListeners, type, listener); },
  };
  context.globalThis = context;

  function dispatch(type, values = {}) {
    const event = {
      code: "",
      key: "",
      repeat: false,
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...values,
    };
    for (const listener of windowListeners.get(type) || []) {
      listener(event);
      if (event.stopped) break;
    }
    return event;
  }

  return {context, windowListeners, dispatch};
}

test("Safari VoiceOver duplicate non-repeat keydowns produce one physical KeyC edge", async () => {
  const source = await readFile(guardUrl, "utf8");
  const realm = fakeKeyboardRealm();
  vm.runInNewContext(source, realm.context, {filename: "free-roam-keyboard-edge-guard-v1.js"});

  let gameKeydowns = 0;
  realm.windowListeners.get("keydown").push(() => { gameKeydowns += 1; });

  const unidentified = realm.dispatch("keydown", {code: "KeyC", key: "Unidentified", repeat: false});
  const duplicateCharacter = realm.dispatch("keydown", {code: "KeyC", key: "C", repeat: false});

  assert.equal(gameKeydowns, 1, "one physical press must reach the game exactly once");
  assert.equal(unidentified.stopped, false);
  assert.equal(duplicateCharacter.prevented, true);
  assert.equal(duplicateCharacter.stopped, true, "the second Safari/VoiceOver keydown must be stopped before the game toggle handler");

  realm.dispatch("keyup", {code: "KeyC", key: "C"});
  realm.dispatch("keydown", {code: "KeyC", key: "C", repeat: false});
  assert.equal(gameKeydowns, 2, "a new physical press after keyup must be accepted normally");
});

test("keyboard edge guard is loaded before the free-roam game module", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const guard = html.indexOf("free-roam-keyboard-edge-guard-v1.js?v=1");
  const game = html.indexOf("free-roam-v4.js?v=66");
  assert.ok(guard >= 0, "the edge guard must be present in the production page");
  assert.ok(game >= 0, "the free-roam game module must be present in the production page");
  assert.ok(guard < game, "the capture guard must register before the game keyboard handler");
  assert.match(html, /vessel-deck-input-bridge-system\.js\?v=2"\s*:\s*"\/src\/vessel\/systems\/vessel-deck-input-bridge-system\.js\?v=5"/);
});
