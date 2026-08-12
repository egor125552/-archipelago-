import test from "node:test";
import assert from "node:assert/strict";

import {VESSEL_MERCHANT_RECOVERY_SYSTEMS} from "../public/src/vessel/systems/vessel-merchant-recovery-system.js";
import {isBoatDockPosition} from "../public/src/free-roam-cargo-rules.js?v=32";

const before = VESSEL_MERCHANT_RECOVERY_SYSTEMS.find(system => system.phase === "before-step");
const after = VESSEL_MERCHANT_RECOVERY_SYSTEMS.find(system => system.phase === "after-step");

test("подъём среднего корабля не откатывается к нулевому корпусу и старым координатам", () => {
  const boat = {
    id: 4,
    label: "средний двухместный корабль",
    x: 262.22,
    y: 78,
    collisionRadius: 13.5,
    hull: 0,
    hullMax: 220,
    sunk: false,
    owner: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    engineStalled: true,
    emergencyActive: true,
    emergencyRemaining: 45,
  };
  const engine = {health: 35, enabled: false, repairActive: false};
  const instance = {
    modules: {engine},
    interior: {
      waterBridge: {
        floodStalled: true,
        floodDisabledModules: {},
      },
    },
  };
  const world = {
    players: [{activeBoat: null, lastBoatId: 0}],
    boats: [
      {id: 0, x: 174, y: 90, collisionRadius: 6, sunk: false},
      null,
      null,
      null,
      boat,
    ],
    events: [
      {
        type: "wreck-recovery-complete",
        sourcePlayer: 0,
        boatId: 4,
        x: 174,
        y: 90,
        text: "Аварийный подъём завершён.",
      },
      {type: "flood-emergency-start", boatId: 4, text: "Авария."},
    ],
  };
  const entry = {boat, instance};

  after.run({world, nativeVessels: [entry], eventStart: 0});

  assert.equal(boat.hull, 44, "подъём должен оставить 20 процентов от максимального корпуса");
  assert.equal(isBoatDockPosition(boat), true, "корабль после подъёма должен реально находиться в зоне сервиса");
  assert.equal(world.players[0].lastBoatId, 4, "поднятый корабль должен стать текущей целью магазина");
  assert.equal(engine.enabled, true, "исправный двигатель не должен оставаться навсегда отключённым после подъёма");
  assert.equal(boat.engineStalled, true, "двигатель остаётся заглушённым до штатного запуска");
  assert.equal(boat.emergencyActive, false);
  assert.equal(world.events.some(event => event.type === "flood-emergency-start" && event.boatId === 4), false);

  engine.enabled = false;
  world.events = [];
  before.run({world, nativeVessels: [entry], eventStart: 0});
  assert.equal(engine.enabled, true, "старое сохранение после подъёма также должно выходить из вечного disabled-состояния двигателя");
});
