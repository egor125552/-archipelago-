import baseWorker, {Lobby as BaseLobby} from "./worker.js";
import {snapshotServerFreeRoom} from "./free-roam-server.js";
import {
  drainEvents,
  setPlayerInput,
  setPlayerPresence,
} from "../public/src/free-roam-core-v6.js";
import {ensurePursuerSquad} from "../public/src/free-roam-pursuer-squad.js";
import {ensureHostileGunners} from "../public/src/free-roam-hostile-gunners.js";

const AUDIT_PURSUER_ID = "audit-pursuer";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"},
  });
}

function localRequest(url) {
  return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
}

function emptyInput() {
  return {
    up: false, down: false, left: false, right: false, run: false,
    pump: false, repair: false, action: false, jump: false, attack: false,
    weapon: false, sonar: false, guide: false,
    shopPrevious: false, shopNext: false, shopBuy: false, shopClose: false,
    boardPrevious: false, boardNext: false, boardAccept: false, boardClose: false,
    targetId: null, navigationTargetId: "objective",
  };
}

function auditEscort(x = 210, y = 118) {
  return {
    id: AUDIT_PURSUER_ID,
    x,
    y,
    heading: 180,
    speed: 0,
    hull: 48,
    maxHull: 48,
    active: true,
    destroyed: false,
    targetPlayer: 0,
    fireCooldown: 999,
    aimRemaining: 0,
    burstRemaining: 0,
    burstCooldown: 0,
    contactCooldown: 0,
    rewardDropped: false,
  };
}

function resetPlayerCombat(player) {
  player.combat ||= {};
  Object.assign(player.combat, {
    alive: true,
    health: 100,
    maxHealth: 100,
    downed: false,
    respawnAt: 0,
    pendingDamage: 0,
    equipped: "pistol",
    pistolAmmo: 100,
    ammo: 100,
    lockedTargetId: null,
  });
  player.combat.weapons ||= {};
  Object.assign(player.combat.weapons, {pistol: true, automatic: true, knife: true});
}

function setupGunnerScenario(room, variant) {
  const serverRoom = room?.freeServer;
  const world = serverRoom?.world;
  if (!world) return null;

  const roofVariant = variant === "roof";
  const player = world.players[0];
  const other = world.players[1];
  const boat = world.boats[0];
  const otherBoat = world.boats[1];

  setPlayerPresence(world, 0, true);
  setPlayerPresence(world, 1, false);
  resetPlayerCombat(player);
  resetPlayerCombat(other);

  Object.assign(player, {
    mode: "foot",
    activeBoat: null,
    x: 210,
    y: roofVariant ? 70 : 34,
    heading: 0,
    airborne: false,
    jumpHeight: 0,
    jumpVelocity: 0,
  });
  Object.assign(other, {mode: "boat", activeBoat: 1, x: 390, y: 290, heading: 180});

  Object.assign(boat, {
    x: roofVariant ? 210 : 310,
    y: roofVariant ? 78 : 170,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    driver: null,
    owner: 0,
    hull: 100,
    water: 0,
    leak: 0,
    sunk: false,
    emergencyActive: false,
    engineStalled: false,
  });
  Object.assign(otherBoat, {
    x: 390, y: 290, heading: 180, speed: 0, throttle: 0, rudder: 0,
    driver: null, hull: 100, water: 0, leak: 0, sunk: false, emergencyActive: false,
  });

  const marauder = world.freeActivities?.marauder;
  if (marauder) Object.assign(marauder, {active: false, destroyed: true, speed: 0});

  const squad = ensurePursuerSquad(world);
  squad.activated = true;
  squad.assignments = {[AUDIT_PURSUER_ID]: 0};
  squad.escorts = [auditEscort()];
  squad.projectiles = [];
  squad.primaryWeapon = {targetPlayer: 0, fireCooldown: 999, aimRemaining: 0, burstRemaining: 0, burstCooldown: 0};

  const gunners = ensureHostileGunners(world);
  gunners.gunners = [];
  gunners.projectiles = [];
  gunners.eliminatedPursuers = [];
  gunners.nextProjectileId = 1;

  if (world.freeHostileActors) {
    world.freeHostileActors.active = false;
    world.freeHostileActors.actors = [];
    world.freeHostileActors.projectiles = [];
  }
  if (world.freeEnemyBoats) {
    world.freeEnemyBoats.active = false;
    world.freeEnemyBoats.boats = [];
    world.freeEnemyBoats.projectiles = [];
  }
  if (world.freeHeavyPursuer?.boat) {
    world.freeHeavyPursuer.boat.active = false;
    world.freeHeavyPursuer.boat.destroyed = true;
  }
  if (world.freeThreatDirector) world.freeThreatDirector.active = false;
  if (world.freeContracts) world.freeContracts.encounterActive = false;
  if (world.freeScenario) {
    world.freeScenario.phase = "victory";
    world.freeScenario.targets[0] = null;
    world.freeScenario.targets[1] = null;
  }

  world.tow = null;
  serverRoom.receivedInputs = [emptyInput(), emptyInput()];
  serverRoom.pendingPulses = [{}, {}];
  serverRoom.inputSequence = [0, 0];
  setPlayerInput(world, 0, emptyInput());
  setPlayerInput(world, 1, emptyInput());
  drainEvents(world);
  serverRoom.lastTickAt = Date.now();
  room.gunnerAudit = {variant, escortX: 210, escortY: 118};

  return {
    room: room.id,
    variant,
    player: {x: player.x, y: player.y, mode: player.mode},
    boat: {x: boat.x, y: boat.y},
    escort: {x: 210, y: 118},
  };
}

export class Lobby extends BaseLobby {
  tickFreeRooms(now = Date.now()) {
    for (const room of this.rooms.values()) {
      const audit = room.gunnerAudit;
      if (!audit || room.mode !== "free" || !room.freeServer?.world) continue;
      const world = room.freeServer.world;
      const squad = ensurePursuerSquad(world);
      let escort = squad.escorts.find(candidate => candidate.id === AUDIT_PURSUER_ID);
      if (!escort) {
        escort = auditEscort(audit.escortX, audit.escortY);
        squad.escorts = [escort];
      }
      Object.assign(escort, {
        x: audit.escortX,
        y: audit.escortY,
        heading: 180,
        speed: 0,
        active: true,
        destroyed: false,
        targetPlayer: 0,
        fireCooldown: 999,
        aimRemaining: 0,
        burstRemaining: 0,
      });
      squad.activated = true;
      squad.assignments = {[AUDIT_PURSUER_ID]: 0};
    }
    return super.tickFreeRooms(now);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/test/gunner-scenario") {
      if (!localRequest(url)) return json({error: "local audit only"}, 403);
      if (request.method !== "POST") return json({error: "POST required"}, 405);
      const roomId = String(url.searchParams.get("room") || "").trim();
      const variant = String(url.searchParams.get("variant") || "standing").trim();
      const room = this.rooms.get(roomId);
      if (!room || room.mode !== "free") return json({error: "room not found"}, 404);
      const result = setupGunnerScenario(room, variant);
      this.broadcastFreeState(room, snapshotServerFreeRoom(room.freeServer, Date.now(), drainEvents(room.freeServer.world)));
      return json(result || {error: "setup failed"}, result ? 200 : 500);
    }
    return super.fetch(request);
  }
}

export default baseWorker;
