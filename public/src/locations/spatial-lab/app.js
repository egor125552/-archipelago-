"use strict";

import {createSpatialLab} from "./location.js";

const {runtime} = createSpatialLab();
runtime.spawnEntity({id: "player.one", label: "Игрок один", spawnId: "lab.spawn.entry"});
runtime.spawnEntity({id: "player.two", label: "Игрок два", spawnId: "lab.spawn.store"});
runtime.refreshActivity();

const status = document.querySelector("#status");
const announcement = document.querySelector("#announcement");
let saved = runtime.saveState();
let audioContext = null;

function say(message) {
  announcement.textContent = "";
  requestAnimationFrame(() => { announcement.textContent = message; });
}

function contextText() {
  const entity = runtime.getEntity("player.one");
  if (!entity) return "Игрок один отсутствует";
  const semantic = runtime.getModule("lab.accessibility").describe("player.one");
  const nearest = semantic.landmarks[0];
  const available = semantic.transitions.filter(entry => entry.available).map(entry => entry.label);
  const elevation = Math.round(semantic.elevation * 10) / 10;
  return `${semantic.space.label}. Высота ${elevation} м. ${nearest ? `Ближайший ориентир: ${nearest.label}, ${nearest.distance.toFixed(1)} м.` : ""} ${available.length ? `Доступные переходы: ${available.join(", ")}.` : "Доступных переходов нет."}`;
}

function render() {
  const player = runtime.getEntity("player.one");
  const world = player ? runtime.getEntityWorldPosition("player.one") : null;
  const diagnostics = runtime.getDiagnostics();
  status.innerHTML = `
    <dt>Игрок один</dt><dd>${player ? `${runtime.location.spacesById.get(player.spaceId).label}; локально ${player.localPosition.x.toFixed(1)}, ${player.localPosition.y.toFixed(1)}, ${player.localPosition.z.toFixed(1)}; мировая высота ${world.z.toFixed(1)} м` : "отсутствует"}</dd>
    <dt>Игрок два</dt><dd>${runtime.getEntity("player.two") ? runtime.location.spacesById.get(runtime.getEntity("player.two").spaceId).label : "отсутствует"}</dd>
    <dt>Удалённый склад</dt><dd>${runtime.getSpaceActivity("lab.remote.store")}</dd>
    <dt>Верхняя дверь лифта</dt><dd>${runtime.getConnectionState("lab.connection.lift.exit")}</dd>
    <dt>Лестничный переход</dt><dd>${runtime.getConnectionState("lab.connection.stairs")}</dd>
    <dt>Ревизия мира</dt><dd>${runtime.revision}</dd>
    <dt>Диагностика</dt><dd>${diagnostics.length ? diagnostics.map(entry => `${entry.code}: ${entry.message}`).join("; ") : "ошибок и предупреждений нет"}</dd>`;
}

async function playAcousticTest() {
  const model = runtime.getModule("lab.acoustics").compute({sourceSpaceId: "lab.yard", listenerSpaceId: "lab.upper.room"});
  audioContext ||= new AudioContext();
  await audioContext.resume();
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const filter = audioContext.createBiquadFilter();
  const dry = audioContext.createGain();
  const delay = audioContext.createDelay(0.5);
  const wet = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(330, now);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(model.lowpassHz, now);
  dry.gain.setValueAtTime(Math.max(0.015, model.gain * (1 - model.reverb * 0.45)), now);
  delay.delayTime.setValueAtTime(0.12 + model.reverb * 0.15, now);
  wet.gain.setValueAtTime(model.gain * model.reverb * 0.45, now);
  oscillator.connect(filter);
  filter.connect(dry).connect(audioContext.destination);
  filter.connect(delay).connect(wet).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.55);
  say(`Акустический тест. Передача ${(model.transmission * 100).toFixed(0)} процентов, фильтр ${Math.round(model.lowpassHz)} герц, реверберация ${(model.reverb * 100).toFixed(0)} процентов.`);
}

function respawnPlayerOne() {
  runtime.removeEntity("player.one");
  runtime.spawnEntity({id: "player.one", label: "Игрок один", spawnId: "lab.spawn.entry"});
  runtime.refreshActivity();
}

async function act(action) {
  switch (action) {
    case "announce":
      say(contextText());
      break;
    case "route": { 
      const entity = runtime.getEntity("player.one");
      const route = runtime.getModule("lab.navigation").findRoute({fromSpaceId: entity.spaceId, toSpaceId: "lab.remote.store"});
      say(runtime.getModule("lab.navigation").describeRoute(route));
      break;
    }
    case "stairs":
      runtime.transitionEntity("player.one", "lab.connection.stairs");
      say(contextText());
      break;
    case "reset":
      respawnPlayerOne();
      say("Игрок один возвращён ко входу во двор.");
      break;
    case "lift-enter":
      runtime.transitionEntity("player.one", "lab.connection.lift.board");
      say(contextText());
      break;
    case "lift-up":
      runtime.setSpaceTransform("lab.lift", {position: {x: 5, y: 5, z: 4}, yaw: 0});
      say(`Лифт поднят. Мировая высота игрока ${runtime.getEntityWorldPosition("player.one").z.toFixed(1)} м.`);
      break;
    case "lift-door": {
      const next = runtime.getConnectionState("lab.connection.lift.exit") === "open" ? "closed" : "open";
      runtime.setConnectionState("lab.connection.lift.exit", next);
      say(next === "open" ? "Верхняя дверь лифта открыта." : "Верхняя дверь лифта закрыта.");
      break;
    }
    case "lift-exit":
      runtime.transitionEntity("player.one", "lab.connection.lift.exit");
      say(contextText());
      break;
    case "stairs-door": {
      const next = runtime.getConnectionState("lab.connection.stairs") === "open" ? "closed" : "open";
      runtime.setConnectionState("lab.connection.stairs", next);
      say(next === "open" ? "Лестничный переход открыт." : "Лестничный переход закрыт. Навигация и акустика уже используют новое состояние.");
      break;
    }
    case "sound":
      await playAcousticTest();
      break;
    case "save":
      saved = runtime.saveState();
      say(`Сохранено состояние ревизии ${saved.revision}.`);
      break;
    case "restore":
      runtime.restoreState(saved);
      say(`Состояние восстановлено. ${contextText()}`);
      break;
    case "second-player":
      if (runtime.getEntity("player.two")) {
        runtime.removeEntity("player.two");
        runtime.refreshActivity();
        say(`Второй игрок удалён. Удалённый склад: ${runtime.getSpaceActivity("lab.remote.store")}.`);
      } else {
        runtime.spawnEntity({id: "player.two", label: "Игрок два", spawnId: "lab.spawn.store"});
        runtime.refreshActivity();
        say(`Второй игрок возвращён на склад. Удалённый склад: ${runtime.getSpaceActivity("lab.remote.store")}.`);
      }
      break;
    default:
      return;
  }
  runtime.refreshActivity();
  render();
}

document.addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  act(button.dataset.action).catch(error => {
    say(`Действие не выполнено: ${error.message}`);
    render();
  });
});

runtime.subscribe(() => render());
render();
say(contextText());
window.spatialLab = Object.freeze({runtime, describe: contextText});
