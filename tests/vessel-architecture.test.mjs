import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {createVesselSemanticEvent, renderModuleSemanticEvent} from "../public/src/vessel/vessel-presentation.js";
import {syncLegacyVesselWorld} from "../public/src/vessel/vessel-legacy-adapter.js";
import {listVesselNavigationTargets, vesselNavigationTargetFromId} from "../public/src/vessel/vessel-navigation.js";
import {
  attachVesselArchitecture,
  nativeVesselByInstanceId,
  nativeVesselForBoat,
  runVesselPhysics,
  spawnVessel,
  vesselRegistry,
} from "../public/src/vessel/vessel-runtime.js";
import {VesselContractError, VESSEL_CONTRACT_VERSION} from "../public/src/vessel/vessel-contract.js";
import {installVesselModule, uninstallVesselModule} from "../public/src/vessel/vessel-modules.js";
import {setVesselOccupantPosition, vesselLandmarkGuidance, vesselLocalToWorld} from "../public/src/vessel/vessel-interior.js";
import {migratePersistedVesselWorld, VESSEL_SAVE_VERSION} from "../public/src/vessel/vessel-save.js";
import {applyVesselDamage} from "../public/src/vessel/vessel-damage.js";
import {assertVesselNetworkCompatibility, vesselNetworkSnapshot, VESSEL_NETWORK_VERSION} from "../public/src/vessel/vessel-network.js";

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

function git(args) {
  return execFileSync("git", args, {encoding: "utf8"});
}

function addedLines(diff) {
  return diff.split("\n")
    .filter(line => line.startsWith("+") && !line.startsWith("+++"))
    .map(line => line.slice(1));
}

test("release contract is version 2 and production contains only current vessel types", () => {
  assert.equal(VESSEL_CONTRACT_VERSION, 2);
  const ids = vesselRegistry().listVesselTypes().map(type => type.id).sort();
  assert.deepEqual(ids, ["dual-turret-patrol", "medium-crew-vessel", "standard"]);
});

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

test("semantic event renders natural text rather than technical ids", () => {
  const registry = createVesselRegistry();
  const moduleType = registry.registerModuleType(moduleDefinition());
  const event = createVesselSemanticEvent("launched", {values: {sourceLabel: "бомбового отсека"}});
  assert.equal(renderModuleSemanticEvent(event, moduleType), "электрошоковая пушка запущена из бомбового отсека.");
});

test("multi-mount modules are validated strictly and installed atomically", () => {
  const registry = createVesselRegistry();
  registry.registerModuleType({
    id: "heavy-generator",
    userFacing: false,
    installation: {mountCount: 2, mountKinds: ["equipment-rail"]},
    createState: () => ({enabled: true}),
  });
  assert.throws(() => registry.registerVesselType({
    id: "bad-heavy-platform",
    label: "Плохая платформа",
    mounts: [{id: "rail-a", kind: "equipment-rail"}],
    modules: [{id: "generator", type: "heavy-generator", mounts: ["rail-a"]}],
  }), VesselContractError);

  const definition = registry.registerVesselType({
    id: "heavy-platform",
    label: "Платформа",
    mounts: [{id: "rail-a", kind: "equipment-rail"}, {id: "rail-b", kind: "equipment-rail"}],
    modules: [],
  });
  const runtime = registry.createInstance(definition.id, {instanceId: "heavy-platform:i1"});
  assert.throws(() => installVesselModule(registry, definition, runtime, {
    id: "generator", type: "heavy-generator", mounts: ["rail-a", "missing"]}), VesselContractError);
  assert.deepEqual(runtime.mountOccupancy, {}, "failed installation must not leave partial occupancy");
  installVesselModule(registry, definition, runtime, {
    id: "generator", type: "heavy-generator", mounts: ["rail-a", "rail-b"]});
  assert.equal(runtime.mountOccupancy["rail-a"], "generator");
  assert.equal(runtime.mountOccupancy["rail-b"], "generator");
  assert.equal(uninstallVesselModule(runtime, "generator"), true);
  assert.deepEqual(runtime.mountOccupancy, {});
});

test("explicit mount accepts can allow an unusual compatible module", () => {
  const registry = createVesselRegistry();
  registry.registerModuleType({id: "odd-device", userFacing: false, installation: {mountCount: 1, mountKinds: ["odd-only"]}});
  const definition = registry.registerVesselType({
    id: "odd-platform",
    label: "Необычная платформа",
    mounts: [{id: "bow", kind: "weapon-hardpoint", accepts: ["odd-device"]}],
    modules: [{id: "device", type: "odd-device", mounts: ["bow"]}],
  });
  assert.equal(definition.modules[0].mounts[0], "bow");
});

test("walkable vessel supports multiple shaped decks and landmark guidance", () => {
  const registry = createVesselRegistry();
  const definition = registry.registerVesselType({
    id: "walkable-fixture",
    label: "Большое судно",
    capabilities: {walkableInterior: true},
    decks: [
      {
        id: "main-deck", label: "главная палуба", level: 0,
        shape: {outer: [[-8, -20], [8, -20], [6, 20], [-6, 20]]},
        zones: [{id: "engine-room", label: "машинное отделение", shape: {outer: [[-3, -8], [3, -8], [3, 0], [-3, 0]]}}],
        landmarks: [{id: "engine", label: "машинное отделение", zoneId: "engine-room", position: [0, -4]}],
        connections: [{id: "stairs-up", label: "лестница наверх", toDeckId: "bridge-deck", from: [0, 8]}],
      },
      {
        id: "bridge-deck", label: "мостик", level: 1,
        shape: {outer: [[-3, -3], [3, -3], [3, 4], [-3, 4]]},
        connections: [{id: "stairs-down", label: "лестница вниз", toDeckId: "main-deck", from: [0, -2]}],
      },
    ],
  });
  const runtime = registry.createInstance(definition.id, {instanceId: "walkable-fixture:i1"});
  setVesselOccupantPosition(definition, runtime, 0, {deckId: "main-deck", zoneId: "engine-room", x: 0, y: -12});
  const guide = vesselLandmarkGuidance(definition, runtime, 0, "engine");
  assert.equal(Math.round(guide.distance), 8);
  assert.match(guide.text, /машинное отделение: 8 м/);
  const worldPoint = vesselLocalToWorld({x: 100, y: 100, heading: 90}, {x: 2, y: 0});
  assert.equal(Math.round(worldPoint.x), 100);
  assert.equal(Math.round(worldPoint.y), 102);
});

test("saved vessel migration is transactional, lossless and stable across repeated loads", () => {
  const source = {boats: [{id: 0, boatType: "standard", hull: 44, customLegacyValue: {kept: true}}], players: []};
  const migrated = migratePersistedVesselWorld(source);
  assert.equal(source.vesselArchitecture, undefined, "source save must remain untouched");
  assert.equal(source.boats[0].vesselInstanceId, undefined, "source boat must remain untouched");
  assert.equal(migrated.vesselArchitecture.saveVersion, VESSEL_SAVE_VERSION);
  assert.equal(migrated.boats[0].customLegacyValue.kept, true);
  const id = migrated.boats[0].vesselInstanceId;
  assert.ok(id);
  assert.equal(migratePersistedVesselWorld(migrated).boats[0].vesselInstanceId, id);
});

test("current boats are adopted as native vessels with stable instance identity", () => {
  const world = {boats: [{id: 0, boatType: "standard", label: "катер", hull: 100}], players: []};
  attachVesselArchitecture(world);
  const first = nativeVesselForBoat(world, 0);
  assert.equal(first.instance.typeId, "standard");
  const id = first.instance.instanceId;
  assert.equal(world.boats[0].vesselInstanceId, id);
  world.boats.push(null);
  attachVesselArchitecture(world);
  assert.equal(nativeVesselByInstanceId(world, id)?.boat, world.boats[0]);
});

test("native spawn uses stable instance ids instead of array identity", () => {
  const world = {boats: [], players: []};
  const first = spawnVessel(world, "standard", {owner: 0, x: 12, y: 34, heading: 90});
  const second = spawnVessel(world, "standard", {owner: 1, x: 20, y: 30});
  assert.notEqual(first.instance.instanceId, second.instance.instanceId);
  assert.equal(first.boat.vesselInstanceId, first.instance.instanceId);
  assert.equal(nativeVesselByInstanceId(world, first.instance.instanceId)?.boat, first.boat);
});

test("manual sonar hiding yields to mission-required navigation without changing the filter", () => {
  const world = {boats: [{id: 0, boatType: "dual-turret-patrol", label: "бронекатер", x: 10, y: 20}], players: [{activeBoat: null}]};
  attachVesselArchitecture(world);
  const initial = listVesselNavigationTargets(world, 0);
  assert.equal(initial.length, 1);
  const targetId = initial[0].id;
  world.vesselNavigation = {hiddenTargets: [targetId]};
  assert.deepEqual(listVesselNavigationTargets(world, 0), []);
  world.vesselNavigation.missionTargets = [targetId];
  const mission = listVesselNavigationTargets(world, 0);
  assert.equal(mission.length, 1);
  assert.equal(mission[0].missionRequired, true);
  assert.deepEqual(world.vesselNavigation.hiddenTargets, [targetId], "mission override must not alter the saved manual filter");
  assert.equal(vesselNavigationTargetFromId(world, 0, targetId)?.missionRequired, true);
});

test("ordinary boats keep global damage while zonal damage is opt-in", () => {
  const standard = vesselRegistry().resolveVesselType("standard");
  const boat = {hull: 100, armor: 0, leak: 0};
  const result = applyVesselDamage(standard, {modules: {}, zones: {}}, boat, {damage: 10});
  assert.equal(result.mode, "global");
  assert.equal(boat.hull, 90);

  const registry = createVesselRegistry();
  registry.registerModuleType({id: "test-engine", userFacing: false, createState: () => ({health: 100, enabled: true})});
  const zonal = registry.registerVesselType({
    id: "zonal-fixture", label: "Зональное судно",
    capabilities: {damageable: true, zonalDamage: true},
    damage: {mode: "zonal", hullShare: 0.2},
    modules: [{id: "engine", type: "test-engine"}],
    decks: [{id: "lower", label: "нижняя палуба", shape: {outer: [[0, 0], [10, 0], [10, 10], [0, 10]]}, zones: [{id: "engine-room", label: "машинное отделение", damageable: true}]}],
  });
  const runtime = registry.createInstance(zonal.id, {instanceId: "zonal-fixture:i1"});
  const zonalBoat = {hull: 100, armor: 0, leak: 0};
  const zonalResult = applyVesselDamage(zonal, runtime, zonalBoat, {damage: 100, zoneId: "engine-room", moduleId: "engine", flooding: 20});
  assert.equal(zonalResult.mode, "zonal");
  assert.equal(runtime.modules.engine.enabled, false);
  assert.equal(runtime.zones["engine-room"].flooding, 20);
  assert.equal(zonalBoat.hull, 80);
});

test("custom physics runs only for vessels that explicitly select its module", () => {
  const registry = vesselRegistry();
  if (!registry.resolvePhysicsModule("test-hover-physics")) {
    registry.registerPhysicsModule({id: "test-hover-physics", step: ({boat}) => { boat.x += 7; }});
  }
  if (!registry.resolveVesselType("test-hover-fixture")) {
    registry.registerVesselType({id: "test-hover-fixture", label: "Тест физики", capabilities: {replicates: false}, physics: {mode: "module", module: "test-hover-physics"}});
  }
  const world = {boats: [], players: []};
  const normal = spawnVessel(world, "standard", {x: 1});
  const hover = spawnVessel(world, "test-hover-fixture", {x: 1});
  runVesselPhysics({world, dt: 0.05});
  assert.equal(normal.boat.x, 1);
  assert.equal(hover.boat.x, 8);
});

test("network snapshot is compact, versioned and excludes static vessel definitions", () => {
  const registry = createVesselRegistry();
  const definition = registry.registerVesselType({
    id: "network-fixture", label: "Сетевое судно", capabilities: {replicates: true},
    runtimeStateFields: ["x", "hull"],
    decks: [{id: "main", label: "палуба", shape: {outer: [[0, 0], [2, 0], [2, 2], [0, 2]]}}],
  });
  const instance = registry.createInstance(definition.id, {instanceId: "network-fixture:i1"});
  const snapshot = vesselNetworkSnapshot({}, registry, [{instance, definition, boat: {id: 3, x: 12, hull: 80}}]);
  assert.equal(snapshot.contract.version, VESSEL_NETWORK_VERSION);
  assert.deepEqual(snapshot.vessels[0].state, {x: 12, hull: 80});
  assert.equal(snapshot.vessels[0].decks, undefined);
  assert.equal(snapshot.vessels[0].presentation, undefined);
  assert.equal(snapshot.vessels[0].definition, undefined);
  assert.equal(assertVesselNetworkCompatibility({version: 1, compatibleFrom: 1}), true);
  assert.throws(() => assertVesselNetworkCompatibility({version: 99, compatibleFrom: 99}), VesselContractError);
});

test("legacy adapter still preserves unknown legacy boats without rewriting them", () => {
  const boat = {id: 9, boatType: "unknown-old-boat", label: "старое судно", x: 10, y: 20, heading: 30, speed: 4};
  const world = {boats: [null, null, null, null, null, null, null, null, null, boat]};
  const [view] = syncLegacyVesselWorld(world);
  assert.equal(view.source, boat);
  boat.x = 99;
  assert.equal(view.x, 99);
  assert.equal(world.boats[9], boat);
});

test("armored engine no longer mutes merely because the stopped boat is unattended", async () => {
  const source = await readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /!occupied\s*&&/);
  assert.match(source, /!boat\s*\|\|\s*boat\.sunk\s*\|\|\s*boat\.reserved\s*\|\|\s*boat\.engineStalled/);
});

test("generic vessel architecture contains no concrete patrol type checks", async () => {
  const files = [
    "vessel-contract.js", "vessel-registry.js", "vessel-defaults.js", "vessel-presentation.js",
    "vessel-content-manifest.js", "vessel-plugin-manifest.js", "vessel-navigation.js", "vessel-runtime.js",
    "vessel-modules.js", "vessel-interior.js", "vessel-save.js", "vessel-network.js", "vessel-damage.js",
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
  assert.match(core, /from "\.\/vessel\/vessel-runtime\.js\?v=2"/);
  assert.match(core, /runVesselSystems\("before-step"/);
  assert.match(core, /runVesselSystems\("after-step"/);
  assert.match(core, /runVesselPhysics\(/);
});

if (process.env.VESSEL_ARCH_STRICT_GIT === "1") {
  test("new code cannot bypass the vessel extension points", async () => {
    const baseline = JSON.parse(await readFile(new URL("./vessel-architecture-baseline.json", import.meta.url), "utf8"));
    assert.match(baseline.baseSha, /^[0-9a-f]{40}$/);
    git(["cat-file", "-e", `${baseline.baseSha}^{commit}`]);

    const changed = git(["diff", "--name-status", `${baseline.baseSha}..HEAD`, "--", "public/src", "src"])
      .trim().split("\n").filter(Boolean)
      .map(line => {
        const [status, ...parts] = line.split("\t");
        return {status, path: parts.at(-1)};
      });

    for (const {status, path} of changed) {
      if (!path) continue;
      const diff = git(["diff", "--unified=0", `${baseline.baseSha}..HEAD`, "--", path]);
      const additions = addedLines(diff);
      const inVesselArchitecture = path.startsWith("public/src/vessel/");
      const isAdapter = path.startsWith("public/src/vessel/adapters/") || path.endsWith("vessel-legacy-adapter.js");
      const isRuntimeFactory = path.endsWith("public/src/vessel/vessel-runtime.js") || path.endsWith("public/src/vessel/vessel-registry.js");
      const isExtensionManifest = path.endsWith("public/src/vessel/vessel-plugin-manifest.js")
        || path.endsWith("public/src/vessel/vessel-content-manifest.js");

      if (status.startsWith("A") && path.startsWith("public/src/") && !inVesselArchitecture) {
        assert.doesNotMatch(path, /(?:boat|ship|vessel|turret|engine|weapon|bomb)[^/]*\.js$/i,
          `new vessel-related source ${path} must live under public/src/vessel/`);
      }

      for (const line of additions) {
        if (!isAdapter) {
          assert.doesNotMatch(line, /\b(?:boatType|vesselType)\b\s*(?:===|!==)\s*["']/,
            `${path}: concrete vessel type branching is forbidden in new code`);
        }
        if (!isRuntimeFactory) {
          assert.doesNotMatch(line, /world\.boats(?:\s*\[[^\]]+\]\s*=|\.push\s*\(|\.splice\s*\()/,
            `${path}: direct world.boats creation/mutation must go through the vessel runtime/factory`);
        }
        if (!isExtensionManifest) {
          assert.doesNotMatch(line, /from\s+["'][^"']*\/vessel\/(?:definitions|modules|systems)\//,
            `${path}: generic code cannot import concrete vessel definitions/modules/systems`);
        }
        if (/public\/src\/free-roam-core.*\.js$/.test(path)) {
          assert.doesNotMatch(line, /from\s+["'][^"']*(?:dual-turret|\/vessel\/(?:definitions|modules|systems)\/)/,
            `${path}: core may depend on vessel-runtime, not concrete vessel implementations`);
        }
      }
    }
  });
}
