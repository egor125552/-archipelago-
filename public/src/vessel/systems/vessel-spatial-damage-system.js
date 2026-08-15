"use strict";

import {
  captureVesselSpatialDamageState,
  reconcileElitePenetrationSpatialDamage,
  reconcileHostileVesselSpatialDamage,
  syncLegacyVesselDamageEffects,
} from "../vessel-spatial-damage.js?v=1";

function beforeStep(context) {
  captureVesselSpatialDamageState(context?.world, context?.nativeVessels || []);
  syncLegacyVesselDamageEffects(context, true);
}

function afterStep(context) {
  reconcileHostileVesselSpatialDamage(context);
  reconcileElitePenetrationSpatialDamage(context);
  syncLegacyVesselDamageEffects(context, false);
}

export const VESSEL_SPATIAL_DAMAGE_SYSTEMS = Object.freeze([
  Object.freeze({id: "vessel-spatial-damage-capture-v1", phase: "before-step", order: 2, run: beforeStep}),
  Object.freeze({id: "vessel-spatial-damage-reconcile-v1", phase: "after-step", order: 96, run: afterStep}),
]);
