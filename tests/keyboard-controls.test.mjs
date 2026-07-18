import test from "node:test";
import assert from "node:assert/strict";

import {
  getKeyboardBinding,
  isEditableKeyboardTarget,
} from "../public/src/keyboard-controls-v1.js";

test("desktop keys map to the same boat controls as touch controls", () => {
  assert.deepEqual(getKeyboardBinding("ArrowLeft"), {kind: "control", control: "left"});
  assert.deepEqual(getKeyboardBinding("ArrowRight"), {kind: "control", control: "right"});
  assert.deepEqual(getKeyboardBinding("ArrowUp"), {kind: "control", control: "forward"});
  assert.deepEqual(getKeyboardBinding("ArrowDown"), {kind: "control", control: "reverse"});
  assert.deepEqual(getKeyboardBinding("s"), {kind: "command", command: "sonar"});
  assert.deepEqual(getKeyboardBinding("S"), {kind: "command", command: "sonar"});
  assert.deepEqual(getKeyboardBinding(" "), {kind: "command", command: "quick"});
  assert.deepEqual(getKeyboardBinding("p"), {kind: "control", control: "pump"});
  assert.deepEqual(getKeyboardBinding("r"), {kind: "control", control: "rescue"});
});

test("VoiceOver modifier chords and typing fields are not captured", () => {
  assert.equal(getKeyboardBinding("ArrowLeft", {ctrlKey: true, altKey: true}), null);
  assert.equal(getKeyboardBinding("ArrowUp", {metaKey: true}), null);
  assert.equal(getKeyboardBinding("s", {isComposing: true}), null);
  assert.equal(getKeyboardBinding("q"), null);

  assert.equal(isEditableKeyboardTarget({tagName: "INPUT"}), true);
  assert.equal(isEditableKeyboardTarget({tagName: "textarea"}), true);
  assert.equal(isEditableKeyboardTarget({tagName: "SELECT"}), true);
  assert.equal(isEditableKeyboardTarget({tagName: "DIV", isContentEditable: true}), true);
  assert.equal(isEditableKeyboardTarget({tagName: "BUTTON"}), false);
});
