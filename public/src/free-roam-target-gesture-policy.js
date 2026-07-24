"use strict";

export function targetMenuGestureAction({pointers, movement, dx, dy}, movementLimit = 24) {
  const count = Math.max(1, Number(pointers) || 1);
  const travelled = Math.max(0, Number(movement) || 0);
  const horizontal = Math.abs(Number(dx) || 0);
  const vertical = Math.abs(Number(dy) || 0);

  if (travelled > movementLimit) {
    const mostlyVertical = vertical >= horizontal * 0.72;
    if (count <= 2 && mostlyVertical) return (Number(dy) || 0) < 0 ? "previous" : "next";
    return "report";
  }
  if (count === 1) return "confirm";
  if (count === 2) return "tap-command";
  return "cancel";
}

export function contextualSonarAction() {
  return "sonar";
}
