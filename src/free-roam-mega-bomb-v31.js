"use strict";

import * as base from "./free-roam-mega-bomb-v30.js";
import {bearing, clamp, sourceVelocity, speed3, surfaceAt} from "./free-roam-mega-bomb-physics-v1.js";

export * from "./free-roam-mega-bomb-v30.js";

const IMPACT_SOUND_SECONDS = 10.6;
const UPDATE_INTERVAL = 0.08;

function emit(world, type, text = "", targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

function boatForPlayer(world, playerIndex) {
  const player = world.players?.[playerIndex];
  if (!player || !["boat", "roof"].includes(player.mode)) return null;
  return world.boats?.find(boat => boat?.id === player.activeBoat)
    || world.boats?.[player.activeBoat]
    || null;
}

function pointForPlayer(world, playerIndex) {
  return boatForPlayer(world, playerIndex) || world.players?.[playerIndex] || null;
}

function listenerVelocity(world, playerIndex) {
  const boat = boatForPlayer(world, playerIndex);
  return boat ? sourceVelocity(boat) : {vx: 0, vy: 0};
}

function wrap(value) {
  return ((Number(value) + 180) % 360 + 360) % 360 - 180;
}

function spatial(world, source) {
  const sourceSpeed = speed3(source);
  return (world.players || []).map((_, index) => {
    const listener = pointForPlayer(world, index);
    if (!listener || world.freeActivities?.presence?.[index] === false) {
      return {
        pan: 0,
        gain: 0,
        distance: 999,
        listenerX: null,
        listenerY: null,
        listenerHeading: 0,
        radialSpeed: 0,
        speed: sourceSpeed,
        elevation: 0,
        occluded: false,
        surface: surfaceAt(source),
      };
    }
    const dx = (Number(source.x) || 0) - (Number(listener.x) || 0);
    const dy = (Number(source.y) || 0) - (Number(listener.y) || 0);
    const horizontal = Math.hypot(dx, dy);
    const metres = Math.hypot(horizontal, Math.max(0, Number(source.z) || 0));
    const relative = wrap(bearing(listener, source) - (Number(listener.heading) || 0));
    const motion = listenerVelocity(world, index);
    const length = horizontal || 1;
    const radialSpeed = (((Number(source.vx) || 0) - motion.vx) * dx
      + ((Number(source.vy) || 0) - motion.vy) * dy) / length;
    return {
      pan: clamp(Math.sin(relative * Math.PI / 180), -1, 1),
      gain: clamp(Math.pow(1 + metres / 48, -1.72), 0, 1),
      distance: Math.round(metres * 10) / 10,
      listenerX: Number(listener.x) || 0,
      listenerY: Number(listener.y) || 0,
      listenerHeading: Number(listener.heading) || 0,
      radialSpeed: Math.round(radialSpeed * 10) / 10,
      speed: Math.round(sourceSpeed * 10) / 10,
      elevation: Math.atan2(Math.max(0, Number(source.z) || 0), Math.max(0.1, horizontal)) * 180 / Math.PI,
      occluded: base.megaBombPathBlocked(source, listener),
      surface: surfaceAt(source),
    };
  });
}

function acousticState(world) {
  world.freeMegaBombAcoustics ||= {impacts: [], seen: []};
  const state = world.freeMegaBombAcoustics;
  if (!Array.isArray(state.impacts)) state.impacts = [];
  if (!Array.isArray(state.seen)) state.seen = [];
  return state;
}

function captureExplosions(world, state) {
  const known = new Set(state.seen);
  for (const event of world.events || []) {
    if (event?.type !== "mega-bomb-explosion") continue;
    const id = String(event.projectileId || "");
    if (!id || known.has(id)) continue;
    known.add(id);
    state.seen.push(id);
    state.impacts.push({
      projectileId: id,
      sourcePlayer: event.sourcePlayer,
      x: Number(event.x) || 0,
      y: Number(event.y) || 0,
      z: Math.max(0, Number(event.z) || 0),
      surface: event.surface || "water",
      reason: event.reason || "impact",
      age: 0,
      nextUpdateAt: 0,
    });
  }
  if (state.seen.length > 128) state.seen.splice(0, state.seen.length - 128);
}

function updateImpactAcoustics(world, state, seconds) {
  const survivors = [];
  for (const impact of state.impacts) {
    impact.age += seconds;
    if (impact.age > IMPACT_SOUND_SECONDS) continue;
    if (impact.age >= impact.nextUpdateAt) {
      impact.nextUpdateAt = impact.age + UPDATE_INTERVAL;
      const source = {...impact, vx: 0, vy: 0, vz: 0};
      emit(world, "mega-bomb-explosion-spatial", "", [0, 1], {
        sourcePlayer: impact.sourcePlayer,
        projectileId: impact.projectileId,
        x: impact.x,
        y: impact.y,
        z: impact.z,
        surface: impact.surface,
        reason: impact.reason,
        age: impact.age,
        duration: IMPACT_SOUND_SECONDS,
        spatial: spatial(world, source),
      });
    }
    survivors.push(impact);
  }
  state.impacts = survivors;
}

export function stepMegaBombs(world, dt) {
  const seconds = clamp(dt, 0, 0.1);
  base.stepMegaBombs(world, seconds);
  const state = acousticState(world);
  captureExplosions(world, state);
  updateImpactAcoustics(world, state, seconds);
}
