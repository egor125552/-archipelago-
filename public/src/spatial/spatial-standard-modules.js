"use strict";

import {computeSpatialAcoustics} from "./spatial-acoustics.js";
import {describeRoute, findSpatialRoute} from "./spatial-navigation.js";
import {filterSpatialInterestSnapshot} from "./spatial-interest.js";
import {SPATIAL_GAMEPLAY_MODULE_TYPES} from "./spatial-gameplay-modules.js";

function ensureObject(value, name) {
  if (value == null) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} config must be an object`);
}

export const STANDARD_SPATIAL_MODULE_TYPES = Object.freeze([
  Object.freeze({
    id: "spatial.navigation",
    validateConfig(config) { ensureObject(config, "navigation"); },
    create(context) {
      return Object.freeze({
        findRoute(args) { return findSpatialRoute(context.read, args); },
        describeRoute(route) { return describeRoute(context.read, route); },
      });
    },
  }),
  Object.freeze({
    id: "spatial.acoustics",
    validateConfig(config) { ensureObject(config, "acoustics"); },
    create(context) {
      return Object.freeze({
        compute(args) { return computeSpatialAcoustics(context.read, args); },
      });
    },
  }),
  Object.freeze({
    id: "spatial.accessibility",
    permissions: ["semantic-context"],
    validateConfig(config) { ensureObject(config, "accessibility"); },
    create(context) {
      return Object.freeze({
        describe(entityId) { return context.describeEntityContext(entityId); },
      });
    },
  }),
  Object.freeze({
    id: "spatial.lifecycle",
    permissions: ["lifecycle"],
    validateConfig(config) { ensureObject(config, "lifecycle"); },
    create(context) {
      return Object.freeze({
        refresh(options) { return context.refreshActivity(options); },
      });
    },
  }),
  Object.freeze({
    id: "spatial.replication",
    permissions: ["replication"],
    validateConfig(config) { ensureObject(config, "replication"); },
    create(context) {
      return Object.freeze({
        snapshot(viewerId, options) {
          return filterSpatialInterestSnapshot(context.read, context.buildInterestSnapshot(viewerId, options), viewerId, options);
        },
      });
    },
  }),
  Object.freeze({
    id: "spatial.persistence",
    permissions: ["persistence"],
    validateConfig(config) { ensureObject(config, "persistence"); },
    create(context) {
      return Object.freeze({
        save() { return context.save(); },
        restore(snapshot) { return context.restore(snapshot); },
      });
    },
  }),
  ...SPATIAL_GAMEPLAY_MODULE_TYPES,
]);
