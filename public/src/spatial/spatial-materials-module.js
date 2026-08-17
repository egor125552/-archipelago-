"use strict";

const PRESETS = Object.freeze({
  concrete: Object.freeze({id:"concrete", label:"бетон", impactAbsorption:0.06, hardness:0.95, breakResistance:0.95, acousticDamping:0.12}),
  metal: Object.freeze({id:"metal", label:"металл", impactAbsorption:0.03, hardness:1, breakResistance:1, acousticDamping:0.08}),
  earth: Object.freeze({id:"earth", label:"земля", impactAbsorption:0.24, hardness:0.55, breakResistance:0.5, acousticDamping:0.32}),
  sand: Object.freeze({id:"sand", label:"песок", impactAbsorption:0.38, hardness:0.35, breakResistance:0.3, acousticDamping:0.46}),
  wood: Object.freeze({id:"wood", label:"дерево", impactAbsorption:0.18, hardness:0.62, breakResistance:0.48, acousticDamping:0.28}),
  glass: Object.freeze({id:"glass", label:"стекло", impactAbsorption:0.02, hardness:0.72, breakResistance:0.16, acousticDamping:0.06}),
  rubber: Object.freeze({id:"rubber", label:"резина", impactAbsorption:0.58, hardness:0.25, breakResistance:0.58, acousticDamping:0.5}),
  water: Object.freeze({id:"water", label:"вода", impactAbsorption:0.72, hardness:0.02, breakResistance:0, acousticDamping:0.44}),
});

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${field} must be finite`);
  return number;
}

function ratio(value, field, fallback) {
  if (value == null) return fallback;
  const number = finite(value, field);
  if (number < 0 || number > 1) throw new RangeError(`${field} must be between 0 and 1`);
  return number;
}

function normalizeProfile(id, value = {}) {
  const base = PRESETS[id] || PRESETS[value.preset] || PRESETS.concrete;
  return Object.freeze({
    id:String(id),
    label:String(value.label || base.label || id),
    impactAbsorption:ratio(value.impactAbsorption, `${id}.impactAbsorption`, base.impactAbsorption),
    hardness:ratio(value.hardness, `${id}.hardness`, base.hardness),
    breakResistance:ratio(value.breakResistance, `${id}.breakResistance`, base.breakResistance),
    acousticDamping:ratio(value.acousticDamping, `${id}.acousticDamping`, base.acousticDamping),
  });
}

export function createSpatialMaterialCatalog(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("materials config must be an object");
  const profiles = new Map(Object.entries(PRESETS));
  for (const [id, value] of Object.entries(config.profiles || {})) profiles.set(id, normalizeProfile(id, value));
  const assignments = Object.freeze({
    spaces:Object.freeze({...config.assignments?.spaces}),
    objects:Object.freeze({...config.assignments?.objects}),
    connections:Object.freeze({...config.assignments?.connections}),
  });
  const defaultMaterialId = String(config.defaultMaterial || "concrete");
  if (!profiles.has(defaultMaterialId)) throw new Error(`unknown default material ${defaultMaterialId}`);

  function get(id) {
    const profile = profiles.get(String(id || defaultMaterialId));
    if (!profile) throw new Error(`unknown material ${id}`);
    return profile;
  }

  return Object.freeze({
    get,
    list() { return Object.freeze([...profiles.values()]); },
    resolve({spaceId=null, objectId=null, connectionId=null, materialId=null} = {}) {
      if (materialId) return get(materialId);
      const assigned = (objectId && assignments.objects[objectId])
        || (connectionId && assignments.connections[connectionId])
        || (spaceId && assignments.spaces[spaceId])
        || defaultMaterialId;
      return get(assigned);
    },
    impact({speed=0, materialId=null, spaceId=null, objectId=null, connectionId=null, waterDepth=0} = {}) {
      const material = get(materialId || (objectId && assignments.objects[objectId]) || (connectionId && assignments.connections[connectionId]) || (spaceId && assignments.spaces[spaceId]) || defaultMaterialId);
      const depth = Math.max(0, Number(waterDepth) || 0);
      const waterBonus = depth <= 0 ? 0 : Math.min(0.62, 0.12 + Math.log1p(depth) * 0.24);
      const absorption = Math.min(0.88, material.impactAbsorption + waterBonus);
      return Object.freeze({material, speed:Math.max(0,Number(speed)||0), absorption, effectiveSpeed:Math.max(0,Number(speed)||0) * Math.sqrt(1 - absorption)});
    },
  });
}

export const SPATIAL_MATERIALS_MODULE_TYPE = Object.freeze({
  id:"spatial.materials",
  validateConfig(config) { createSpatialMaterialCatalog(config || {}); },
  create(context) { return createSpatialMaterialCatalog(context.config || {}); },
});

export {PRESETS as SPATIAL_MATERIAL_PRESETS};
