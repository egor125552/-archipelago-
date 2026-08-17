"use strict";

import {distance3d, localToWorld} from "./spatial-transform.js";

function wrapDegrees(value) {
  return ((Number(value) + 180) % 360 + 360) % 360 - 180;
}

function freezeEntry(value) {
  return Object.freeze({...value, position: value.position ? Object.freeze({...value.position}) : null});
}

export function relativeSpatialDirection(listener, target) {
  const dx = (Number(target?.x) || 0) - (Number(listener?.x) || 0);
  const dy = (Number(target?.y) || 0) - (Number(listener?.y) || 0);
  const bearing = Math.atan2(dx, -dy) * 180 / Math.PI;
  const relative = wrapDegrees(bearing - (Number(listener?.heading) || 0));
  if (Math.abs(relative) <= 25) return "прямо";
  if (Math.abs(relative) >= 155) return "позади";
  return relative < 0 ? "слева" : "справа";
}

function worldPoint(runtime, spaceId, localPosition) {
  return localToWorld(runtime.location, spaceId, localPosition, runtime.dynamicTransforms || new Map());
}

function addNearby(entries, runtime, listener, heading, maximumDistance, item) {
  const position = worldPoint(runtime, item.spaceId, item.localPosition);
  const metres = distance3d(listener, position);
  if (metres > maximumDistance) return;
  entries.push(freezeEntry({
    ...item.semantic,
    metres,
    direction: relativeSpatialDirection({...listener, heading}, position),
    position,
  }));
}

function connectionElevationDelta(runtime, entitySpaceId, destinationSpaceId) {
  if (!destinationSpaceId) return 0;
  try {
    const current = worldPoint(runtime, entitySpaceId, {x:0,y:0,z:0});
    const destination = worldPoint(runtime, destinationSpaceId, {x:0,y:0,z:0});
    return (Number(destination.z) || 0) - (Number(current.z) || 0);
  } catch {
    return 0;
  }
}

export function nearbySpatialSemantics(runtime, entityId, {maximumDistance = 20, heading = 0} = {}) {
  if (!runtime?.location?.spacesById || typeof runtime.getEntity !== "function" || typeof runtime.getEntityWorldPosition !== "function") {
    throw new TypeError("runtime must expose spatial location and entity position APIs");
  }
  const entity = runtime.getEntity(entityId);
  if (!entity) return Object.freeze([]);
  const listener = runtime.getEntityWorldPosition(entityId);
  const space = runtime.location.spacesById.get(entity.spaceId);
  if (!space) return Object.freeze([]);
  const limit = Math.max(0, Number(maximumDistance) || 0);
  const entries = [];

  for (const anchor of space.anchors || []) {
    if (anchor.navigation === false) continue;
    addNearby(entries, runtime, listener, heading, limit, {
      spaceId: space.id,
      localPosition: anchor.position,
      semantic: {
        id: anchor.id,
        type: "anchor",
        kind: anchor.kind,
        label: anchor.presentation?.label || anchor.label || anchor.id,
        description: anchor.presentation?.description || "",
        available: true,
      },
    });
  }

  for (const object of space.objects || []) {
    if (object.userFacing === false) continue;
    addNearby(entries, runtime, listener, heading, limit, {
      spaceId: space.id,
      localPosition: object.position,
      semantic: {
        id: object.id,
        type: "object",
        kind: object.kind,
        label: object.presentation?.label || object.label || object.id,
        description: object.presentation?.description || "",
        available: true,
      },
    });
  }

  for (const connection of runtime.location.connections || []) {
    let endpoint = null;
    let destinationSpaceId = null;
    if (connection.from.spaceId === entity.spaceId) {
      endpoint = connection.from;
      destinationSpaceId = connection.to.spaceId;
    } else if (connection.bidirectional && connection.to.spaceId === entity.spaceId) {
      endpoint = connection.to;
      destinationSpaceId = connection.from.spaceId;
    }
    if (!endpoint) continue;
    const state = typeof runtime.getConnectionState === "function" ? runtime.getConnectionState(connection.id) : connection.initialState;
    addNearby(entries, runtime, listener, heading, limit, {
      spaceId: entity.spaceId,
      localPosition: endpoint.position,
      semantic: {
        id: connection.id,
        type: "connection",
        kind: connection.kind,
        label: connection.presentation?.label || connection.label || connection.id,
        description: connection.presentation?.description || "",
        destinationSpaceId,
        destinationLabel: runtime.location.spacesById.get(destinationSpaceId)?.presentation?.label || runtime.location.spacesById.get(destinationSpaceId)?.label || destinationSpaceId,
        elevationDelta: connectionElevationDelta(runtime, entity.spaceId, destinationSpaceId),
        state,
        available: connection.passableStates.includes(state),
      },
    });
  }

  entries.sort((a, b) => a.metres - b.metres || a.label.localeCompare(b.label, "ru"));
  return Object.freeze(entries);
}

export function describeSpatialSemanticContext(runtime, entityId, options = {}) {
  const entity = runtime?.getEntity?.(entityId);
  if (!entity) return null;
  const space = runtime.location?.spacesById?.get(entity.spaceId);
  if (!space) return null;
  const worldPosition = runtime.getEntityWorldPosition(entityId);
  return Object.freeze({
    location: Object.freeze({
      id: runtime.location.id,
      label: runtime.location.presentation?.label || runtime.location.label || runtime.location.id,
      description: runtime.location.presentation?.description || "",
      role: runtime.location.presentation?.role || null,
    }),
    space: Object.freeze({
      id: space.id,
      label: space.presentation?.label || space.label || space.id,
      description: space.presentation?.description || "",
      role: space.presentation?.role || null,
    }),
    elevation: Number(worldPosition.z) || 0,
    nearby: nearbySpatialSemantics(runtime, entityId, options),
  });
}

function connectionAction(entry) {
  if (entry?.type !== "connection") return "";
  const destination = entry.destinationLabel ? `: ${entry.destinationLabel}` : "";
  const vertical = ["stairs", "ladder", "lift"].includes(entry.kind);
  const delta = Number(entry.elevationDelta) || 0;
  if (vertical && delta > 0.25) return ` Нажми действие, чтобы подняться${destination}.`;
  if (vertical && delta < -0.25) return ` Нажми действие, чтобы спуститься${destination}.`;
  return ` Нажми действие, чтобы пройти${destination}.`;
}

export function describeNearbySpatialEntry(entry, {actionReady = false} = {}) {
  const distance = Math.max(1, Math.round(Number(entry?.metres) || 0));
  const label = entry?.label || "Объект";
  if (entry?.available === false) {
    return `${label}: ${distance} метров. Переход сейчас закрыт.${actionReady ? " Нажми действие, чтобы открыть." : ""}`;
  }
  const action = actionReady ? connectionAction(entry) : "";
  return `${label}: ${distance} метров.${action}`;
}
