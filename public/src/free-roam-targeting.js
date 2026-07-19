"use strict";

import {activePursuers, assignedPursuerForPlayer} from "./free-roam-pursuer-squad.js?v=32";
import {activeHostileGunners} from "./free-roam-hostile-gunners.js?v=32";

const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

function playerModeLabel(player) {
  if (player?.mode === "boat") return "в лодке";
  if (player?.mode === "roof") return "на крыше лодки";
  if (player?.mode === "swim") return "в воде";
  return "на берегу";
}

export function listCombatTargets(world, attackerIndex, maximumRange = Infinity) {
  const attacker = world.players?.[attackerIndex];
  if (!attacker) return [];
  const presence = world.freeActivities?.presence || [];
  const targets = [];

  for (let index = 0; index < (world.players || []).length; index += 1) {
    if (index === attackerIndex || !presence[index]) continue;
    const player = world.players[index];
    if (player?.combat?.alive && ["foot", "swim", "roof"].includes(player.mode)) {
      targets.push({
        id: `player-${index}`,
        kind: "player",
        playerIndex: index,
        point: player,
        label: `игрок ${index + 1}, ${playerModeLabel(player)}`,
      });
    }
    const boat = world.boats?.find(candidate => (
      !candidate.sunk
      && (candidate.owner === index || candidate.driver === index)
    ));
    if (boat) {
      targets.push({
        id: `boat-${boat.id}`,
        kind: "boat",
        boatId: boat.id,
        playerIndex: index,
        point: boat,
        label: `лодка игрока ${index + 1}`,
      });
    }
  }

  const assigned = assignedPursuerForPlayer(world, attackerIndex);
  for (const pursuer of activePursuers(world)) {
    targets.push({
      id: pursuer.id,
      kind: pursuer === world.freeActivities?.marauder ? "marauder" : "escort",
      pursuerId: pursuer.id,
      point: pursuer,
      label: pursuer === assigned ? "твой катер-преследователь" : "другой катер-преследователь",
      assigned: pursuer === assigned,
    });
  }
  for (const gunner of activeHostileGunners(world)) {
    targets.push({
      id: gunner.id,
      kind: "gunner",
      gunnerId: gunner.id,
      point: gunner,
      label: gunner.targetPlayer === attackerIndex
        ? "стрелок, который преследует тебя"
        : "стрелок другого преследователя",
      assigned: gunner.targetPlayer === attackerIndex,
    });
  }

  return targets
    .map(target => ({...target, distance: distance(attacker, target.point)}))
    .filter(target => target.distance <= maximumRange)
    .sort((left, right) => Number(right.assigned) - Number(left.assigned) || left.distance - right.distance);
}

export function resolveCombatTarget(world, attackerIndex, targetId, maximumRange = Infinity) {
  if (!targetId) return null;
  return listCombatTargets(world, attackerIndex, maximumRange)
    .find(target => target.id === targetId) || null;
}

export function describeCombatTarget(target, position = 0, total = 1) {
  if (!target) return "Доступных целей нет.";
  const number = Math.max(1, position + 1);
  const metres = Math.round(target.distance);
  const hull = ["boat", "marauder", "escort"].includes(target.kind)
    ? `, корпус ${Math.round(target.point?.hull || 0)}`
    : target.kind === "gunner"
      ? `, здоровье ${Math.round(target.point?.health || 0)}`
    : "";
  return `Цель ${number} из ${Math.max(1, total)}: ${target.label}, ${metres} метров${hull}.`;
}
