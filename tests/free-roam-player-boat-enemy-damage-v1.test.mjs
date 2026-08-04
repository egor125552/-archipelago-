import test from "node:test";
import assert from "node:assert/strict";

import {createFreeWorld, stepFreeWorld} from "../public/src/free-roam-core-v6.js";
import {activatePursuerSquad, updatePursuerSquad} from "../public/src/free-roam-pursuer-squad.js";
import {ensureEnemyBoats, updateEnemyBoats} from "../public/src/free-roam-enemy-boats.js";

function placeShot(projectile, boat, damage = 1.5) {
  Object.assign(projectile, {
    x: boat.x,
    y: boat.y - 1,
    vx: 0,
    vy: 20,
    ttl: 1,
    damage,
    nearMissAnnounced: [false, false],
  });
}

function placePlayerOnBoat(world, boat) {
  Object.assign(world.players[0], {x: boat.x, y: boat.y, mode: "boat", activeBoat: boat.id});
  boat.driver = 0;
}

test("pursuer bullets hand zero hull to the canonical emergency lifecycle", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.hull = 1;
  activatePursuerSquad(world);
  const state = world.freePursuerSquad;
  state.projectiles = [{id:"test-pursuer-shot",sourcePursuerId:"pursuer-2",targetPlayer:0,sourceX:boat.x,sourceY:boat.y-2}];
  placeShot(state.projectiles[0], boat);

  updatePursuerSquad(world, 0.1);
  assert.equal(boat.hull, 0);
  assert.equal(boat.emergencyActive, false);

  stepFreeWorld(world, 0.05);
  assert.equal(boat.emergencyActive, true);
  assert.equal(boat.hull, 0.05);
  assert.equal(boat.engineStalled, true);
  assert.equal(world.events.filter(event => event.type === "flood-emergency-start").length, 1);
});

test("pursuers stop damaging emergency hull but can still hit its living passenger", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.hull = 0.05;
  boat.emergencyActive = true;
  placePlayerOnBoat(world, boat);
  activatePursuerSquad(world);
  const state = world.freePursuerSquad;
  state.projectiles = [{id:"emergency-rider-pursuer-shot",sourcePursuerId:"pursuer-2",targetPlayer:0,sourceX:boat.x,sourceY:boat.y-2}];
  placeShot(state.projectiles[0], boat);
  const before = world.events.length;
  let playerHits = 0;

  updatePursuerSquad(world, 0.1, {damagePlayer(){ playerHits += 1; return true; }});
  assert.equal(world.events.slice(before).some(event => event.type === "enemy-bullet-boat-hit"), false);
  assert.equal(playerHits, 1);
});

test("threat-group bullets hand zero hull to the canonical emergency lifecycle", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.hull = 2;
  const state = ensureEnemyBoats(world);
  state.active = true;
  state.boats = [];
  state.projectiles = [{id:"test-threat-shot",boatId:"threat-boat-3",targetPlayer:0,x:boat.x,y:boat.y-1,vx:0,vy:20,ttl:1}];

  updateEnemyBoats(world, 0.1);
  assert.equal(boat.hull, 0);
  stepFreeWorld(world, 0.05);
  assert.equal(boat.emergencyActive, true);
  assert.equal(world.events.filter(event => event.type === "flood-emergency-start").length, 1);
});

test("threat group stops damaging emergency hull but can still shoot its passenger", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.hull = 0.05;
  boat.emergencyActive = true;
  placePlayerOnBoat(world, boat);
  const state = ensureEnemyBoats(world);
  state.active = true;
  state.boats = [{
    id:"threat-boat-1",role:"rammer",active:true,destroyed:false,hostile:true,
    x:boat.x,y:boat.y,heading:0,speed:18,targetPlayer:0,contactCooldown:0,
    fireCooldown:1,aimRemaining:0,burstRemaining:0,burstCooldown:0,
  }];
  state.projectiles = [{id:"emergency-rider-threat-shot",boatId:"threat-boat-1",targetPlayer:0,x:boat.x,y:boat.y-1,vx:0,vy:20,ttl:1}];
  const before = world.events.length;
  let playerHits = 0;

  updateEnemyBoats(world, 0.1, {damagePlayer(){ playerHits += 1; return true; }});
  const fresh = world.events.slice(before);
  assert.equal(fresh.some(event => event.type === "enemy-bullet-boat-hit"), false);
  assert.equal(fresh.some(event => event.type === "enemy-ram-hit"), false);
  assert.equal(playerHits, 1);
});
