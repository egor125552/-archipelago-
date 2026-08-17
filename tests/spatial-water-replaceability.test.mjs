import test from "node:test";
import assert from "node:assert/strict";

import {compileSpatialLocation, createSpatialModuleRegistry} from "../public/src/spatial/spatial-compiler.js";
import {createSpatialRuntime} from "../public/src/spatial/spatial-runtime.js";
import {STANDARD_SPATIAL_MODULE_TYPES} from "../public/src/spatial/spatial-standard-modules.js";
import {SPATIAL_LAB_LOCATION} from "../public/src/locations/spatial-lab/location.js";

const clone = value => structuredClone(value);

function withoutStandardWater() {
  const definition = clone(SPATIAL_LAB_LOCATION);
  definition.id = "location.spatial.lab.no-water";
  definition.modules = definition.modules.filter(module => module.type !== "spatial.water");
  return definition;
}

test("standard water module can be completely omitted without changing spatial core", () => {
  const definition = withoutStandardWater();
  const registry = createSpatialModuleRegistry(STANDARD_SPATIAL_MODULE_TYPES);
  const compiled = compileSpatialLocation(definition, {moduleRegistry: registry, mode: "development"});
  const runtime = createSpatialRuntime(compiled);
  assert.equal(compiled.modules.some(module => module.type === "spatial.water"), false);
  assert.equal(runtime.getModule("lab.water"), null);
  runtime.spawnEntity({id: "player.no-water", spawnId: "lab.spawn.entry"});
  assert.equal(runtime.getEntity("player.no-water").spaceId, "lab.yard");
  assert.ok(runtime.getModule("lab.navigation"));
  assert.ok(runtime.getModule("lab.acoustics"));
});

test("location can replace standard water with an unrelated custom module type", () => {
  const definition = withoutStandardWater();
  definition.id = "location.spatial.lab.custom-water";
  definition.modules.push({id: "lab.custom-water", type: "test.custom-water", config: {depth: 0.75}});
  const replacement = Object.freeze({
    id: "test.custom-water",
    validateConfig(config) {
      if (!Number.isFinite(Number(config?.depth))) throw new TypeError("replacement depth must be finite");
    },
    create(context) {
      return Object.freeze({kind: "custom-water", depth: Number(context.config.depth)});
    },
  });
  const registry = createSpatialModuleRegistry([...STANDARD_SPATIAL_MODULE_TYPES, replacement]);
  const compiled = compileSpatialLocation(definition, {moduleRegistry: registry, mode: "development"});
  const runtime = createSpatialRuntime(compiled);
  assert.equal(compiled.modules.some(module => module.type === "spatial.water"), false);
  assert.equal(runtime.getModule("lab.custom-water").kind, "custom-water");
  assert.equal(runtime.getModule("lab.custom-water").depth, 0.75);
});
