import test from "node:test";
import assert from "node:assert/strict";
import {ensureCombat, updateCombat} from "../public/src/free-roam-combat-v2.js?v=6";
import {createFreeWorld, stepFreeWorld} from "../public/src/free-roam-core-v6.js?v=1";

function worldWithExtendedHullTarget() {
  const targetBoat = {
    id: 1,
    owner: 1,
    driver: 1,
    crew: [1],
    boatType: "medium-crew-vessel",
    vesselType: "medium-crew-vessel",
    x: 0,
    y: -20,
    heading: 180,
    hull: 220,
    hullMax: 220,
    armor: 0,
    armorMax: 0,
    leak: 0,
    sunk: false,
  };
  const world = {
    time: 1,
    boats: [null, targetBoat],
    players: [
      {id: 0, mode: "foot", activeBoat: null, x: 0, y: 0, heading: 0},
      {id: 1, mode: "boat", activeBoat: 1, x: 0, y: -20, heading: 180},
    ],
    freeActivities: {
      presence: [true, true],
      inputs: [{attack: true, weapon: false, targetId: "boat-1"}, {attack: false}],
      previousInputs: [{attack: false, weapon: false, targetId: "boat-1"}, {attack: false}],
      marauder: null,
    },
    events: [],
  };
  ensureCombat(world);
  world.players[0].combat.weapons.automatic = true;
  world.players[0].combat.ammo = 10;
  world.players[0].combat.equipped = "automatic";
  world.players[0].combat.lockedTargetId = "boat-1";
  world.players[0].combat.lastTargetRequestId = "boat-1";
  return {world, targetBoat};
}

test("automatic fire subtracts damage from a 220-hull vessel instead of clamping it to 100", () => {
  const {world, targetBoat} = worldWithExtendedHullTarget();
  updateCombat(world, 0.2, {});
  assert.equal(targetBoat.hull, 215);
  assert.equal(targetBoat.hullMax, 220);
  const event = world.events.find(item => item.type === "gun-boat-damaged" && item.targetBoat === 1);
  assert.ok(event, "target vessel should receive a boat damage event");
  assert.equal(event.hull, 215);
  assert.equal(event.hullMax, 220);
  assert.match(event.text, /215 из 220/);
});

test("pistol fire also respects hullMax above 100", () => {
  const {world, targetBoat} = worldWithExtendedHullTarget();
  world.players[0].combat.equipped = "pistol";
  world.players[0].combat.pistolAmmo = 10;
  world.players[0].combat.pistolCooldown = 0;
  updateCombat(world, 0.4, {});
  assert.ok(targetBoat.hull > 100, `pistol must not collapse extended hull to 100; got ${targetBoat.hull}`);
  assert.ok(targetBoat.hull < 220);
  const event = world.events.find(item => item.type === "gun-boat-damaged" && item.targetBoat === 1);
  assert.ok(event);
  assert.equal(event.hullMax, 220);
});

test("legacy marauder ram keeps a 220-hull vessel on its real hull scale", () => {
  const world = createFreeWorld();
  const targetBoat = world.boats.find(Boolean);
  assert.ok(targetBoat, "free-roam world should have a player boat");

  for (const boat of world.boats || []) {
    if (!boat || boat === targetBoat) continue;
    boat.sunk = true;
    boat.driver = null;
    boat.owner = null;
    boat.cargo = [];
  }

  Object.assign(targetBoat, {
    owner: 0,
    driver: 0,
    crew: [0],
    x: 210,
    y: 180,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    hull: 220,
    hullMax: 220,
    leak: 0,
    sunk: false,
    emergencyActive: false,
    cargo: [],
  });
  Object.assign(world.players[0], {
    mode: "boat",
    activeBoat: targetBoat.id,
    x: targetBoat.x,
    y: targetBoat.y,
    heading: targetBoat.heading,
  });
  world.players[0].combat.alive = true;
  world.freeActivities.presence[0] = true;
  world.freeActivities.presence[1] = false;

  const marauder = world.freeActivities.marauder;
  Object.assign(marauder, {
    x: targetBoat.x,
    y: targetBoat.y + 8,
    heading: 0,
    speed: 10,
    active: true,
    destroyed: false,
    respawnAt: 0,
    targetBoat: targetBoat.id,
    ramCooldown: 0,
    stealCooldown: 0,
    recoveryRemaining: 0,
    cargo: [],
  });

  stepFreeWorld(world, 0.1);

  const ram = world.events.find(item => item.type === "pursuer-ram" && item.targetBoat === targetBoat.id);
  assert.ok(ram, "marauder should ram the prepared target boat");
  assert.ok(targetBoat.hull > 100, `legacy ram must not clamp 220 hull to 100; got ${targetBoat.hull}`);
  assert.ok(targetBoat.hull < 220, "the ram should still deal its normal damage");
  assert.match(ram.text, /Корпус \d+ из 220/);
});
