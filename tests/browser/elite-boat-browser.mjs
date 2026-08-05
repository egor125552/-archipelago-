import assert from "node:assert/strict";
import {chromium} from "playwright";

const baseUrl = process.env.ARCHIPELAGO_TEST_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({headless: true});
const page = await browser.newPage();
const browserErrors = [];
page.on("pageerror", error => browserErrors.push(String(error?.stack || error)));
page.on("console", message => { if (message.type() === "error") browserErrors.push(`console: ${message.text()}`); });

try {
  await page.goto(`${baseUrl}/elite-boat-browser-harness.html`, {waitUntil: "domcontentloaded"});
  const result = await page.evaluate(async () => {
    const stamp = Date.now();
    const core = await import(`/src/free-roam-core-v6.js?elite-browser=${stamp}`);
    const bossApi = await import(`/src/free-roam-elite-boat.js?elite-browser=${stamp}`);
    const actors = await import(`/src/free-roam-hostile-actors.js?elite-browser=${stamp}`);
    const replication = await import(`/src/free-roam-replication.js?elite-browser=${stamp}`);

    const world = core.createFreeWorld();
    world.freeScenario.phase = "victory";
    core.setPlayerPresence(world, 0, true);
    core.setPlayerPresence(world, 1, true);
    for (let index = 0; index < 2; index += 1) {
      const player = world.players[index];
      player.mode = "boat";
      player.activeBoat = index;
      world.boats[index].driver = index;
      world.boats[index].owner = index;
      world.boats[index].x = 175 + index * 55;
      world.boats[index].y = 180;
      player.x = world.boats[index].x;
      player.y = world.boats[index].y;
    }

    const state = bossApi.startEliteBoatBoss(world, 77, {x: 205, y: 180}, 0);
    state.phase = "boat-combat";
    state.boat.x = 305;
    state.boat.y = 180;
    state.boat.heading = -90;
    state.boat.speed = 0;
    state.boat.turrets[0].fireCooldown = 0;
    state.boat.turrets[1].fireCooldown = 0;

    const initialTargets = bossApi.eliteBossCombatTargets(world, 0).map(target => target.id);
    for (let tick = 0; tick < 50; tick += 1) bossApi.updateEliteBoatBoss(world, 0.04, {});
    const turretShots = world.events.filter(event => event.type === "elite-turret-shot");
    const shotTurrets = [...new Set(turretShots.map(event => event.turretId))];
    const muzzlePositions = [...new Set(turretShots.map(event => `${event.turretId}:${event.x.toFixed(2)}:${event.y.toFixed(2)}`))];

    bossApi.damageEliteBoatBoss(world, "turret-port", 520, 0, {weapon: "automatic"});
    const shotsBefore = world.events.filter(event => event.type === "elite-turret-shot" && event.turretId === "elite-turret-starboard").length;
    for (let tick = 0; tick < 120; tick += 1) bossApi.updateEliteBoatBoss(world, 0.04, {});
    const shotsAfter = world.events.filter(event => event.type === "elite-turret-shot" && event.turretId === "elite-turret-starboard").length;

    for (const layer of ["outer", "middle", "inner"]) bossApi.damageEliteBoatBoss(world, `armor-${layer}`, 1000, 0, {weapon: "automatic"});
    const hullTarget = bossApi.eliteBossCombatTargets(world, 0)[0]?.id;
    bossApi.damageEliteBoatBoss(world, "hull", 5000, 0, {weapon: "automatic"});
    for (let tick = 0; tick < 50; tick += 1) bossApi.updateEliteBoatBoss(world, 0.04, {});
    const commanders = actors.activeHostileActors(world).filter(actor => actor.commander);
    const commander = commanders[0];
    const phaseBeforeCommanderDeath = state.phase;
    if (commander) actors.damageHostileActor(world, commander.id, 800, 0, {weapon: "mega-bomb"});
    bossApi.updateEliteBoatBoss(world, 0.04, {});

    const left = replication.replicatedFreeWorld(world, 0);
    const right = replication.replicatedFreeWorld(world, 1);
    const liveRegion = document.getElementById("status");
    liveRegion.textContent = `Проверка завершена. Фаза ${state.phase}.`;

    return {
      version: state.version,
      initialTargets,
      shotTurrets,
      muzzlePositions,
      projectilePeak: Math.max(0, ...world.events.filter(event => event.type === "elite-turret-shot").map((_event, index) => index + 1)),
      starboardContinued: shotsAfter > shotsBefore,
      portDestroyed: state.boat.turrets[0].destroyed,
      starboardDestroyed: state.boat.turrets[1].destroyed,
      armor: state.boat.armorLayers.map(layer => ({id: layer.id, hp: layer.hp, state: layer.state})),
      hullTarget,
      phaseBeforeCommanderDeath,
      commanderCount: commanders.length,
      commanderId: commander?.id || null,
      finalPhase: state.phase,
      completionEvents: world.events.filter(event => event.type === "elite-boss-completed").length,
      replicasEqual: JSON.stringify(left.freeEliteBoatBoss) === JSON.stringify(right.freeEliteBoatBoss),
      liveText: liveRegion.textContent,
    };
  });

  assert.deepEqual(browserErrors, [], browserErrors.join("\n"));
  assert.equal(result.version, "1.0.0");
  assert.deepEqual(result.initialTargets, ["elite-armor-outer", "elite-turret-port", "elite-turret-starboard"]);
  assert.deepEqual(result.shotTurrets.sort(), ["elite-turret-port", "elite-turret-starboard"]);
  assert.ok(result.muzzlePositions.length >= 2, "turrets did not use distinct physical launch points");
  assert.equal(result.portDestroyed, true);
  assert.equal(result.starboardDestroyed, false);
  assert.equal(result.starboardContinued, true, "the surviving turret stopped with the destroyed turret");
  assert.deepEqual(result.armor.map(layer => layer.hp), [0, 0, 0]);
  assert.equal(result.hullTarget, "elite-hull");
  assert.equal(result.phaseBeforeCommanderDeath, "commander-combat");
  assert.equal(result.commanderCount, 1);
  assert.ok(result.commanderId?.startsWith("elite-commander-"));
  assert.equal(result.finalPhase, "completed");
  assert.equal(result.completionEvents, 1);
  assert.equal(result.replicasEqual, true);
  assert.match(result.liveText, /Фаза completed/);
  console.log(JSON.stringify({scenario: "elite-boat-release-1.0", ...result}, null, 2));
} finally {
  await browser.close();
}
