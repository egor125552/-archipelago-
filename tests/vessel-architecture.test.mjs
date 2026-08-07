import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {createVesselSemanticEvent, renderModuleSemanticEvent} from "../public/src/vessel/vessel-presentation.js";
import {syncLegacyVesselWorld} from "../public/src/vessel/vessel-legacy-adapter.js";
import {VesselContractError} from "../public/src/vessel/vessel-contract.js";

function moduleDefinition() {
  return {
    id: "electric-gun",
    userFacing: true,
    capabilities: ["fire"],
    semanticEvents: ["station-entered", "launched"],
    presentation: {
      label: "электрошоковая пушка",
      roles: {operatorRole: "оператора электрошоковой пушки"},
      events: {
        "station-entered": "Ты занял место {operatorRole}.",
        launched: "{label} запущена из {sourceLabel}.",
      },
    },
  };
}

test("preset and explicit definitions normalize through one strict registry", () => {
  const registry = createVesselRegistry();
  registry.registerPreset(STANDARD_BOAT_PRESET);
  registry.registerModuleType(moduleDefinition());
  const presetBoat = registry.registerVesselType({
    id: "test-preset-boat",
    preset: "standard-boat",
    label: "Тестовый катер",
    capabilities: {towable: false},
    modules: [{id: "bow-gun", type: "electric-gun"}],
  });
  const explicitBoat = registry.registerVesselType({
    id: "test-explicit-boat",
    label: "Явный катер",
    capabilities: {boardable: true, exitable: true, towable: false},
    modules: [],
  });
  assert.equal(presetBoat.capabilities.boardable, true);
  assert.equal(presetBoat.capabilities.towable, false);
  assert.equal(explicitBoat.capabilities.towable, false);
});

test("user-facing module cannot register without speech metadata for declared events", () => {
  const registry = createVesselRegistry();
  assert.throws(() => registry.registerModuleType({
    id: "silent-cannon",
    semanticEvents: ["launched"],
    presentation: {label: "пушка", events: {}},
  }), VesselContractError);
});

test("semantic event renders natural text from presentation metadata rather than technical ids", () => {
  const registry = createVesselRegistry();
  const moduleType = registry.registerModuleType(moduleDefinition());
  const event = createVesselSemanticEvent("launched", {values: {sourceLabel: "бомбового отсека"}});
  assert.equal(renderModuleSemanticEvent(event, moduleType), "электрошоковая пушка запущена из бомбового отсека.");
});

test("legacy boats can be viewed through vessel architecture without rewriting runtime objects", () => {
  const boat = {id: 2, boatType: "dual-turret-patrol", x: 10, y: 20, heading: 30, speed: 4, physicsProfile: {id: "heavy"}};
  const world = {boats: [null, null, boat]};
  const [view] = syncLegacyVesselWorld(world);
  assert.equal(view.source, boat);
  assert.equal(view.typeId, "dual-turret-patrol");
  boat.x = 99;
  assert.equal(view.x, 99);
  assert.equal(world.boats[2], boat);
});

test("new fundamental vessel systems are registered plugins, not hard-coded branches", () => {
  const registry = createVesselRegistry();
  const calls = [];
  registry.registerSystem({id: "test-power-grid", phase: "before-step", run: context => calls.push(context.token)});
  registry.runSystems("before-step", {token: "ok"});
  assert.deepEqual(calls, ["ok"]);
});

test("generic vessel architecture contains no concrete patrol type checks", async () => {
  const files = [
    "vessel-contract.js",
    "vessel-registry.js",
    "vessel-defaults.js",
    "vessel-presentation.js",
    "vessel-plugin-manifest.js",
    "vessel-runtime.js",
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../public/src/vessel/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /dual-turret-patrol|new-super-ship/);
    assert.doesNotMatch(source, /(?:boatType|vesselType)\s*===\s*["']/);
  }
});

test("legacy core cannot grow direct concrete vessel type comparisons", async () => {
  const core = await readFile(new URL("../public/src/free-roam-core-v8.js", import.meta.url), "utf8");
  assert.doesNotMatch(core, /(?:boatType|vesselType)\s*===\s*["']/);
  const legacyImports = core.match(/from "\.\/free-roam-dual-turret-[^"]+"/g) || [];
  assert.equal(legacyImports.length, 4, "legacy patrol imports are frozen; new vessel integrations must use vessel architecture");
  assert.match(core, /from "\.\/vessel\/vessel-runtime\.js\?v=1"/);
  assert.match(core, /runVesselSystems\("before-step"/);
  assert.match(core, /runVesselSystems\("after-step"/);
});
