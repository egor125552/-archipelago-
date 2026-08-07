import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createVesselRegistry} from "../public/src/vessel/vessel-registry.js";
import {STANDARD_BOAT_PRESET} from "../public/src/vessel/vessel-defaults.js";
import {createVesselSemanticEvent, renderModuleSemanticEvent} from "../public/src/vessel/vessel-presentation.js";
import {syncLegacyVesselWorld} from "../public/src/vessel/vessel-legacy-adapter.js";
import {listVesselNavigationTargets, vesselNavigationTargetFromId} from "../public/src/vessel/vessel-navigation.js";
import {spawnVessel, vesselRegistry, nativeVesselForBoat} from "../public/src/vessel/vessel-runtime.js";
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

function git(args) {
  return execFileSync("git", args, {encoding: "utf8"});
}

function addedLines(diff) {
  return diff.split("\n")
    .filter(line => line.startsWith("+") && !line.startsWith("+++"))
    .map(line => line.slice(1));
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
  const boat = {id: 2, boatType: "dual-turret-patrol", label: "двухместный бронекатер", x: 10, y: 20, heading: 30, speed: 4, physicsProfile: {id: "heavy"}};
  const world = {boats: [null, null, boat]};
  const [view] = syncLegacyVesselWorld(world);
  assert.equal(view.source, boat);
  assert.equal(view.typeId, "dual-turret-patrol");
  boat.x = 99;
  assert.equal(view.x, 99);
  assert.equal(world.boats[2], boat);
});

test("navigable legacy vessel is offered remotely and excluded while aboard", () => {
  const boat = {id: 2, boatType: "dual-turret-patrol", label: "двухместный бронекатер", x: 210, y: 102, sunk: false, reserved: false};
  const world = {boats: [null, null, boat], players: [{activeBoat: 0}, {activeBoat: null}]};
  const remoteTargets = listVesselNavigationTargets(world, 1);
  assert.deepEqual(remoteTargets.map(target => target.id), ["vessel:2"]);
  assert.equal(vesselNavigationTargetFromId(world, 1, "vessel:2")?.label, "двухместный бронекатер");
  boat.x = 245;
  assert.equal(vesselNavigationTargetFromId(world, 1, "vessel:2")?.x, 245, "moving vessel target must use live coordinates");
  world.players[1].activeBoat = 2;
  assert.deepEqual(listVesselNavigationTargets(world, 1), []);
  assert.equal(vesselNavigationTargetFromId(world, 1, "vessel:2"), null);
});

test("native vessels materialize through the single runtime spawn path", () => {
  const registry = vesselRegistry();
  if (!registry.resolveVesselType("architecture-test-boat")) {
    registry.registerVesselType({
      id: "architecture-test-boat",
      preset: "standard-boat",
      label: "Архитектурный тестовый катер",
      capabilities: {towable: false},
    });
  }
  const world = {boats: []};
  const {instance, boat} = spawnVessel(world, "architecture-test-boat", {owner: 0, x: 12, y: 34, heading: 90});
  assert.equal(world.boats[0], boat);
  assert.equal(boat.id, 0);
  assert.equal(boat.boatType, "architecture-test-boat");
  assert.equal(boat.vesselType, "architecture-test-boat");
  assert.equal(boat.owner, 0);
  assert.equal(boat.driver, 0);
  assert.equal(boat.hull, 100);
  assert.equal(instance.legacyBoatId, 0);
  assert.equal(nativeVesselForBoat(world, 0)?.instance, instance);
});

test("new fundamental vessel systems are registered plugins, not hard-coded branches", () => {
  const registry = createVesselRegistry();
  const calls = [];
  registry.registerSystem({id: "test-power-grid", phase: "before-step", run: context => calls.push(context.token)});
  registry.runSystems("before-step", {token: "ok"});
  assert.deepEqual(calls, ["ok"]);
});

test("armored engine no longer mutes merely because the stopped boat is unattended", async () => {
  const source = await readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /!occupied\s*&&/);
  assert.match(source, /!boat\s*\|\|\s*boat\.sunk\s*\|\|\s*boat\.reserved\s*\|\|\s*boat\.engineStalled/);
});

test("generic vessel architecture contains no concrete patrol type checks", async () => {
  const files = [
    "vessel-contract.js",
    "vessel-registry.js",
    "vessel-defaults.js",
    "vessel-presentation.js",
    "vessel-content-manifest.js",
    "vessel-plugin-manifest.js",
    "vessel-navigation.js",
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
