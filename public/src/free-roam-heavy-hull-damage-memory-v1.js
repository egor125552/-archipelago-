"use strict";

import {currentHeavyBoat,ensureControllerState,values} from "./free-roam-heavy-ai-support-v1.js?v=1";

function isHullDamageEvent(event) {
  return (event?.type==="heavy-component-hit"&&event.component==="hull")
    ||(event?.type==="mega-bomb-heavy-focused-hit"&&String(event.component||"").includes("корпус"));
}
function eventRemainingHull(event) {
  const match=String(event?.text||"").match(/Осталось\s+([0-9]+(?:[.,][0-9]+)?)/i);
  return match?Number(match[1].replace(",",".")):null;
}
function latestHullDamageMetadata(world,sinceAt,now,currentHull) {
  const candidates=values(world.events).filter(event=>{
    if (!isHullDamageEvent(event)) return false;
    const at=Number(event.at);
    return !Number.isFinite(at)||(at>=sinceAt-0.5&&at<=now+0.25);
  });
  return [...candidates].reverse().find(event=>{
    const remaining=eventRemainingHull(event);
    return Number.isFinite(remaining)&&Math.abs(remaining-currentHull)<=1.1;
  })||candidates.at(-1)||null;
}
function stageKey(state,heavy) {
  return `${String(state.encounterId??heavy?.encounterId??"")}:${heavy?.armourBreached?"core":"armour"}`;
}
function resetMemory(memory,key,hull,now) {
  memory.key=key;memory.hull=hull;memory.at=now;memory.capturedAt=null;
}

/**
 * Входящий урон игрока может быть применён до prepareHeavyAiControllerV1.
 * Тогда снимок текущего кадра уже содержит уменьшенный hull и внутрикадровая
 * разница равна нулю. Этот мост возвращает в тот же снимок последнее значение
 * корпуса с предыдущего серверного тика. Решения о фазе и маршруте по-прежнему
 * принимает только free-roam-heavy-ai-controller-v1.
 */
export function captureHeavyHullDamageCarryoverV1(world) {
  const state=ensureControllerState(world),boat=currentHeavyBoat(world),heavy=state.heavy,frame=state.frame;
  if (!boat||!heavy||!frame?.boat) return 0;
  const now=Number(world.time)||0,hull=Number(boat.hull),key=stageKey(state,heavy);
  if (!Number.isFinite(hull)) return 0;
  state.hullDamageCarryoverV1||={key:null,hull:null,at:-999,capturedAt:null};
  const memory=state.hullDamageCarryoverV1;
  if (memory.key!==key||!Number.isFinite(Number(memory.hull))||now<Number(memory.at)||hull>Number(memory.hull)+0.5) {
    resetMemory(memory,key,hull,now);return 0;
  }
  if (Number(memory.capturedAt)===now) return 0;
  const previousHull=Number(memory.hull),damage=Math.max(0,previousHull-hull);
  memory.capturedAt=now;
  if (damage<0.5) return 0;

  frame.boat.hull=Math.max(Number(frame.boat.hull)||0,previousHull);
  const metadata=latestHullDamageMetadata(world,Number(memory.at)||now,now,hull);
  world.events||=[];
  world.events.push({
    type:"heavy-component-hit",text:"",targets:[],at:now,operationEvent:true,
    sourcePlayer:Number.isInteger(Number(metadata?.sourcePlayer))?Number(metadata.sourcePlayer):null,
    component:"hull",weapon:metadata?.weapon||metadata?.type||"carryover",
    x:boat.x,y:boat.y,carryoverMeasurementV1:true,measuredDamage:damage,
  });
  heavy.lastDamageAt=now;
  return damage;
}

export function finalizeHeavyHullDamageCarryoverV1(world) {
  if (Array.isArray(world.events)) world.events=world.events.filter(event=>!event?.carryoverMeasurementV1);
  const state=ensureControllerState(world),boat=currentHeavyBoat(world),heavy=state.heavy;
  if (!boat||!heavy) {
    state.hullDamageCarryoverV1=null;return false;
  }
  const hull=Number(boat.hull),now=Number(world.time)||0;
  if (!Number.isFinite(hull)) return false;
  state.hullDamageCarryoverV1||={};
  resetMemory(state.hullDamageCarryoverV1,stageKey(state,heavy),hull,now);
  return true;
}
