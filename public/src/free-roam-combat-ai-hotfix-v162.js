"use strict";

import {applyCombatAiHotfixV161} from "./free-roam-combat-ai-hotfix-v161.js?v=1";

function livingPlayers(world) {
  return (world.players || [])
    .map((player, index) => ({player, index}))
    .filter(({player, index}) => world.freeActivities?.presence?.[index] && player?.combat?.alive);
}

function activeThreatBoats(world) {
  const boats = [];
  const add = boat => {
    if (boat?.active && !boat.destroyed) boats.push(boat);
  };
  add(world.freeActivities?.marauder);
  for (const boat of world.freePursuerSquad?.escorts || []) add(boat);
  for (const boat of world.freeEnemyBoats?.boats || []) add(boat);
  add(world.freeHeavyPursuer?.boat);
  return boats;
}

function weaponFor(serial) {
  if (serial % 4 === 0) return "knife";
  return serial % 2 ? "automatic" : "pistol";
}

function makeActor(id, boat, targetPlayer, serial) {
  const weapon = weaponFor(serial);
  const maxHealth = weapon === "knife" ? 58 : weapon === "automatic" ? 52 : 44;
  return {
    id,
    boatId: boat.id,
    targetPlayer,
    x: boat.x,
    y: boat.y,
    heading: boat.heading,
    state: "aboard",
    weapon,
    health: maxHealth,
    maxHealth,
    active: true,
    destroyed: false,
    elite: false,
    fireCooldown: 0.5 + (serial % 6) * 0.21,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    attackCooldown: 0.25 + (serial % 4) * 0.12,
    windupRemaining: 0,
    targetLockUntil: 0,
    seatOffset: serial % 2 ? 2.2 : -2.2,
    strandedAt: 0,
    stepCooldown: 0,
    smartAmmo: weapon === "automatic" ? 8 : weapon === "pistol" ? 5 : 0,
    threatPhase: 1,
    finalWave: false,
  };
}

function enforceStrongestOpening(world) {
  const director = world.freeThreatDirector;
  if (!director?.active || Number(director.level) < 5) return;
  const living = livingPlayers(world);
  const boats = activeThreatBoats(world);
  const hostile = world.freeHostileActors;
  if (!living.length || !boats.length || !hostile) return;
  hostile.actors ||= [];
  hostile.active = true;
  const desired = living.length > 1 ? 12 : 10;
  let activeCount = hostile.actors.filter(actor => actor?.active && !actor.destroyed).length;
  let serial = 1;
  const encounterId = Number(director.encounterId) || 0;
  while (activeCount < desired) {
    const id = `v162-opening-${encounterId}-${serial}`;
    if (!hostile.actors.some(actor => actor.id === id)) {
      const boat = boats[activeCount % boats.length];
      const target = living[activeCount % living.length];
      hostile.actors.push(makeActor(id, boat, target.index, serial));
      activeCount += 1;
    }
    serial += 1;
  }
}

export function applyCombatAiHotfixV162(world, dt, helpers = {}) {
  applyCombatAiHotfixV161(world, dt, helpers);
  enforceStrongestOpening(world);
}
