"use strict";

const LOOT_KINDS = Object.freeze(["ammo", "plates", "fuel", "valuable"]);

function emit(world, type, text, targets = [0, 1], extra = {}) {
  world.events ||= [];
  world.events.push({type, text, targets, at: world.time, operationEvent: true, ...extra});
  if (world.events.length > 180) world.events.splice(0, world.events.length - 180);
}

export const ENCOUNTER_REWARDS = Object.freeze({2: 40, 3: 90, 4: 180, 5: 500});
export const ENCOUNTER_LOOT_COUNTS = Object.freeze({2: 1, 3: 2, 4: 4, 5: 6});

export function awardEncounter(world, level, point = {x: 210, y: 180}) {
  const director = world.freeThreatDirector;
  if (!director || director.rewardIssued) return null;
  director.rewardIssued = true;
  const credits = ENCOUNTER_REWARDS[level] || 0;
  const count = ENCOUNTER_LOOT_COUNTS[level] || 0;
  world.freeActivities.credits = (Number(world.freeActivities.credits) || 0) + credits;
  const spawned = [];
  for (let index = 0; index < count; index += 1) {
    const kind = LOOT_KINDS[index % LOOT_KINDS.length];
    const crate = {
      id: `crate-encounter-${director.encounterId}-${index + 1}`,
      kind,
      label: kind === "ammo" ? "боевые патроны" : kind === "plates" ? "трофейная ремонтная пластина" : kind === "fuel" ? "трофейная канистра" : "ценный трофей",
      rarity: level >= 5 || index === count - 1 ? "rare" : "uncommon",
      weight: kind === "valuable" ? 4 : 2,
      x: Math.max(12, Math.min(408, point.x + (index % 2 ? 1 : -1) * (8 + index * 3))),
      y: Math.max(84, Math.min(308, point.y + Math.floor(index / 2) * 7)),
      state: "world",
      carriedBy: null,
      stowedBoat: null,
      source: "encounter",
      singleUse: true,
    };
    world.freeActivities.crates.push(crate);
    spawned.push(crate.id);
  }
  emit(world, "encounter-reward", `Группа уничтожена. Боевая премия ${credits} кредитов. В мире осталось трофейных грузов: ${count}. Баланс команды ${world.freeActivities.credits}.`, [0, 1], {level, credits, lootCount: count, x: point.x, y: point.y});
  return {credits, count, spawned};
}
