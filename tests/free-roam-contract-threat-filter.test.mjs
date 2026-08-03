import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_BOARD,
  createContractsState,
  ensureContracts,
  handleContractBoardAction,
  updateContractBoard,
} from "../public/src/free-roam-contracts.js";

const blankInput = () => ({
  boardPrevious: false,
  boardNext: false,
  boardAccept: false,
  boardClose: false,
});

function makeWorld(playerCount = 2) {
  return {
    time: 10,
    events: [],
    freeScenario: {phase: "victory"},
    players: Array.from({length: playerCount}, () => ({
      mode: "foot",
      x: CONTRACT_BOARD.x,
      y: CONTRACT_BOARD.y,
      combat: {alive: true, ammo: 0, pistolAmmo: 0},
    })),
    boats: Array.from({length: playerCount}, (_, owner) => ({owner, cargo: []})),
    freeActivities: {
      presence: Array.from({length: playerCount}, () => true),
      inputs: Array.from({length: playerCount}, blankInput),
      previousInputs: Array.from({length: playerCount}, blankInput),
      crates: [],
      credits: 0,
    },
    freeContracts: createContractsState(playerCount),
  };
}

function pulse(world, playerIndex, key) {
  world.freeActivities.previousInputs[playerIndex] = blankInput();
  world.freeActivities.inputs[playerIndex] = {...blankInput(), [key]: true};
  updateContractBoard(world);
  world.freeActivities.previousInputs[playerIndex] = {...world.freeActivities.inputs[playerIndex]};
  world.freeActivities.inputs[playerIndex] = blankInput();
  updateContractBoard(world);
}

function lastText(world) {
  return world.events.at(-1)?.text || "";
}

function enterDangerousMenu(world, playerIndex = 0) {
  assert.equal(handleContractBoardAction(world, playerIndex), true);
  pulse(world, playerIndex, "boardNext");
  pulse(world, playerIndex, "boardNext");
  assert.match(lastText(world), /Опасная работа/);
  pulse(world, playerIndex, "boardAccept");
}

test("dangerous work opens real threat counts and accepts a threat-five order", () => {
  const world = makeWorld();
  enterDangerousMenu(world);

  assert.equal(world.freeContracts.boardMode[0], "danger-threats");
  assert.match(lastText(world), /Угроза 2 из пяти/);
  assert.match(lastText(world), /Доступно 7 заказов/);

  pulse(world, 0, "boardNext");
  pulse(world, 0, "boardNext");
  pulse(world, 0, "boardNext");
  assert.match(lastText(world), /Угроза 5 из пяти/);
  assert.match(lastText(world), /тяжёлый катер и элитный стрелок/);

  pulse(world, 0, "boardAccept");
  assert.equal(world.freeContracts.boardMode[0], "danger-offers");
  assert.equal(world.freeContracts.boardThreat[0], 5);
  assert.match(lastText(world), /Выбрана угроза 5 из пяти/);
  assert.match(lastText(world), /Угроза 5 из пяти/);

  pulse(world, 0, "boardAccept");
  assert.equal(world.freeContracts.activeContract.category, "dangerous");
  assert.equal(world.freeContracts.activeContract.threat, 5);
  assert.equal(world.freeContracts.boardOpen[0], false);
  assert.equal(world.freeActivities.crates.length, 1);
});

test("back moves one level at a time before closing the board", () => {
  const world = makeWorld();
  enterDangerousMenu(world);
  pulse(world, 0, "boardNext");
  pulse(world, 0, "boardNext");
  pulse(world, 0, "boardAccept");
  assert.equal(world.freeContracts.boardMode[0], "danger-offers");
  assert.equal(world.freeContracts.boardThreat[0], 4);

  pulse(world, 0, "boardClose");
  assert.equal(world.freeContracts.boardOpen[0], true);
  assert.equal(world.freeContracts.boardMode[0], "danger-threats");
  assert.match(lastText(world), /Уровни угрозы/);
  assert.match(lastText(world), /Угроза 4 из пяти/);

  pulse(world, 0, "boardClose");
  assert.equal(world.freeContracts.boardOpen[0], true);
  assert.equal(world.freeContracts.boardMode[0], "root");
  assert.match(lastText(world), /Виды работ/);
  assert.match(lastText(world), /Опасная работа/);

  pulse(world, 0, "boardClose");
  assert.equal(world.freeContracts.boardOpen[0], false);
  assert.match(lastText(world), /Доска заказов закрыта/);
});

test("each player keeps an independent board level", () => {
  const world = makeWorld();
  enterDangerousMenu(world, 0);
  handleContractBoardAction(world, 1);

  assert.equal(world.freeContracts.boardMode[0], "danger-threats");
  assert.equal(world.freeContracts.boardMode[1], "root");
  pulse(world, 0, "boardNext");
  assert.equal(world.freeContracts.boardSelection[0], 1);
  assert.equal(world.freeContracts.boardSelection[1], 0);
});

test("old saved contract state migrates without losing the board", () => {
  const world = makeWorld();
  delete world.freeContracts.boardMode;
  delete world.freeContracts.boardThreat;
  ensureContracts(world);
  assert.deepEqual(world.freeContracts.boardMode, ["root", "root"]);
  assert.deepEqual(world.freeContracts.boardThreat, [null, null]);
});
