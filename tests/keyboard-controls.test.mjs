import test from "node:test";
import assert from "node:assert/strict";

import {
  getKeyboardBinding,
  isEditableKeyboardTarget,
} from "../public/src/keyboard-controls-v1.js";

test("desktop controls use the requested MacBook layout", () => {
  assert.deepEqual(getKeyboardBinding("ArrowLeft", {}, "ArrowLeft"), {kind: "control", control: "left"});
  assert.deepEqual(getKeyboardBinding("ArrowRight", {}, "ArrowRight"), {kind: "control", control: "right"});
  assert.deepEqual(getKeyboardBinding("ArrowUp", {}, "ArrowUp"), {kind: "control", control: "forward"});
  assert.deepEqual(getKeyboardBinding("ArrowDown", {}, "ArrowDown"), {kind: "control", control: "reverse"});
  assert.deepEqual(getKeyboardBinding("ы", {}, "KeyS"), {kind: "command", command: "sonar"});
  assert.deepEqual(getKeyboardBinding("с", {}, "KeyC"), {kind: "toggle-control", control: "pump"});
  assert.deepEqual(getKeyboardBinding("м", {}, "KeyV"), {kind: "toggle-control", control: "hullRepair"});
  assert.deepEqual(getKeyboardBinding("к", {}, "KeyR"), {kind: "toggle-control", control: "rescue"});
  assert.deepEqual(getKeyboardBinding(" ", {}, "Space"), {kind: "command", command: "anchor"});
  assert.deepEqual(getKeyboardBinding("Enter", {}, "Enter"), {kind: "command", command: "quick"});
});

test("VoiceOver chords and typing fields are never captured", () => {
  assert.equal(getKeyboardBinding("ArrowLeft", {ctrlKey: true, altKey: true}, "ArrowLeft"), null);
  assert.equal(getKeyboardBinding("ArrowUp", {metaKey: true}, "ArrowUp"), null);
  assert.equal(getKeyboardBinding("s", {isComposing: true}, "KeyS"), null);
  assert.equal(getKeyboardBinding("q", {}, "KeyQ"), null);

  assert.equal(isEditableKeyboardTarget({tagName: "INPUT"}), true);
  assert.equal(isEditableKeyboardTarget({tagName: "textarea"}), true);
  assert.equal(isEditableKeyboardTarget({tagName: "SELECT"}), true);
  assert.equal(isEditableKeyboardTarget({tagName: "DIV", isContentEditable: true}), true);
  assert.equal(isEditableKeyboardTarget({tagName: "BUTTON"}), false);
});
