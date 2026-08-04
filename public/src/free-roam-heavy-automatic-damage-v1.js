"use strict";

const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number(value)||0));

export const HEAVY_AUTOMATIC_FULL_DAMAGE_DISTANCE=55;
export const HEAVY_AUTOMATIC_MID_DISTANCE=115;
export const HEAVY_AUTOMATIC_LONG_DISTANCE=170;
export const HEAVY_AUTOMATIC_MAX_DISTANCE=220;

function mix(a,b,amount) {
  return a+(b-a)*clamp(amount,0,1);
}

export function heavyAutomaticDamageScaleV1(metres) {
  const distance=Number(metres);
  if (!Number.isFinite(distance)) return 1;
  if (distance<=HEAVY_AUTOMATIC_FULL_DAMAGE_DISTANCE) return 1;
  if (distance<=HEAVY_AUTOMATIC_MID_DISTANCE) {
    return mix(1,0.72,(distance-HEAVY_AUTOMATIC_FULL_DAMAGE_DISTANCE)/(HEAVY_AUTOMATIC_MID_DISTANCE-HEAVY_AUTOMATIC_FULL_DAMAGE_DISTANCE));
  }
  if (distance<=HEAVY_AUTOMATIC_LONG_DISTANCE) {
    return mix(0.72,0.4,(distance-HEAVY_AUTOMATIC_MID_DISTANCE)/(HEAVY_AUTOMATIC_LONG_DISTANCE-HEAVY_AUTOMATIC_MID_DISTANCE));
  }
  if (distance<=HEAVY_AUTOMATIC_MAX_DISTANCE) {
    return mix(0.4,0.125,(distance-HEAVY_AUTOMATIC_LONG_DISTANCE)/(HEAVY_AUTOMATIC_MAX_DISTANCE-HEAVY_AUTOMATIC_LONG_DISTANCE));
  }
  return 0;
}

export function heavyAutomaticDamageV1(baseDamage,metres) {
  const raw=Math.max(0,Number(baseDamage)||0);
  return Math.round(raw*heavyAutomaticDamageScaleV1(metres)*1000)/1000;
}
