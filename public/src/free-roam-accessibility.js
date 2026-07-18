"use strict";

const shortcuts = Object.freeze({
  leftButton: {key: "ArrowLeft", code: "ArrowLeft", duration: 480},
  rightButton: {key: "ArrowRight", code: "ArrowRight", duration: 480},
  upButton: {key: "ArrowUp", code: "ArrowUp", duration: 650},
  downButton: {key: "ArrowDown", code: "ArrowDown", duration: 650},
});

function dispatchKey(type, binding) {
  window.dispatchEvent(new KeyboardEvent(type, {
    key: binding.key,
    code: binding.code,
    bubbles: true,
    cancelable: true,
  }));
}

for (const [id, binding] of Object.entries(shortcuts)) {
  const button = document.getElementById(id);
  if (!button) continue;
  button.addEventListener("click", event => {
    if (event.detail !== 0) return;
    event.preventDefault();
    dispatchKey("keydown", binding);
    setTimeout(() => dispatchKey("keyup", binding), binding.duration);
  });
}
