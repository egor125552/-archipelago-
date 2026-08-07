"use strict";

import {VesselContractError, assertId, isPlainObject} from "./vessel-contract.js";

const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

function safeText(value) {
  return String(value ?? "").trim();
}

function renderTemplate(template, values) {
  const missing = new Set();
  const text = String(template).replace(PLACEHOLDER_RE, (_match, key) => {
    const value = safeText(values[key]);
    if (!value) missing.add(key);
    return value;
  });
  if (missing.size) {
    throw new VesselContractError(`speech template is missing values: ${[...missing].join(", ")}`, {template, missing: [...missing]});
  }
  return text;
}

export function createVesselSemanticEvent(kind, details = {}) {
  return Object.freeze({
    kind: assertId(kind, "semantic event kind"),
    ...details,
  });
}

export function renderModuleSemanticEvent(event, moduleType, instancePresentation = {}) {
  if (!isPlainObject(event)) throw new VesselContractError("semantic event must be an object");
  const kind = assertId(event.kind, "semantic event kind");
  const presentation = moduleType?.presentation;
  const eventPresentation = presentation?.events?.[kind];
  if (!eventPresentation?.template) {
    throw new VesselContractError(`module ${moduleType?.id || "unknown"} has no presentation for ${kind}`);
  }
  const values = {
    label: safeText(instancePresentation.label) || presentation.label,
    ...presentation.forms,
    ...presentation.roles,
    ...instancePresentation.forms,
    ...instancePresentation.roles,
    ...event.values,
  };
  return renderTemplate(eventPresentation.template, values);
}
