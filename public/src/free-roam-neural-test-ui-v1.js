"use strict";

export const NEURAL_THREAT_MIN = 2;
export const NEURAL_THREAT_MAX = 5;
const LEVEL_STORAGE_KEY = "echo-free-roam-neural-threat-level";

export function normalizeNeuralThreatLevel(value) {
  return Math.max(NEURAL_THREAT_MIN, Math.min(NEURAL_THREAT_MAX, Math.floor(Number(value) || NEURAL_THREAT_MIN)));
}

export function neuralTrainingStartBody(level) {
  return {
    level: {
      level: normalizeNeuralThreatLevel(level),
      neuralOnly: true,
    },
    record: true,
  };
}

function readStoredLevel() {
  try { return normalizeNeuralThreatLevel(localStorage.getItem(LEVEL_STORAGE_KEY)); }
  catch (_) { return NEURAL_THREAT_MIN; }
}

function storeLevel(level) {
  try { localStorage.setItem(LEVEL_STORAGE_KEY, String(level)); } catch (_) {}
}

function currentRoomId() {
  return String(globalThis.__freeRoam?.roomId?.() || "").trim().slice(0, 32);
}

function announce(text, assertive = false) {
  const message = document.getElementById("message");
  const live = document.getElementById("live");
  if (message) message.textContent = text;
  if (!live) return;
  live.setAttribute("aria-live", assertive ? "assertive" : "polite");
  live.textContent = "";
  requestAnimationFrame(() => { live.textContent = text; });
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload || {};
}

async function downloadArchive(roomId) {
  const response = await fetch(`/api/training/archive?room=${encodeURIComponent(roomId)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `echo-neural-battles-${roomId}.zip`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

function heavyTurretText(runtime) {
  const shadow = runtime?.neuralShadow;
  if ((runtime?.level || 0) !== 5) return "";
  if (!shadow?.heavyTurretTracked) return " Тяжёлая установка пока не обнаружена нейронным контроллером.";
  const probability = Math.round((Number(shadow.heavyTurretFireProbability) || 0) * 100);
  return ` Тяжёлая установка отслеживается отдельно; разрешение огня ${shadow.heavyTurretFire ? "активно" : "ожидает"}, вероятность ${probability} процентов.`;
}

function statusText(runtime, level) {
  if (!runtime?.trainingActive) {
    return "Тестовый бой не запущен. Обычный мир работает без нейронного управления.";
  }
  if (runtime.neuralOnly && runtime.neuralShadow?.controlEnabled) {
    return `Идёт угроза ${runtime.level || level}. Тактическими решениями врагов управляет нейросеть.${heavyTurretText(runtime)}`;
  }
  return `Идёт обычный быстрый бой угрозы ${runtime.level || level}. Нейросеть не управляет врагами.`;
}

export function installNeuralTestUi(root = document) {
  if (!root?.getElementById || root.getElementById("neuralTestSettings")) return null;
  const closeButton = root.getElementById("settingsCloseButton");
  const card = closeButton?.closest?.(".settings-card");
  if (!closeButton || !card) return null;

  let level = readStoredLevel();
  let busy = false;
  let active = false;
  let archiveEpisodes = 0;

  const section = root.createElement("section");
  section.id = "neuralTestSettings";
  section.className = "settings-group";
  section.setAttribute("aria-labelledby", "neuralTestSettingsTitle");
  section.innerHTML = `
    <h3 id="neuralTestSettingsTitle">Тест нейросети</h3>
    <p id="neuralTestDescription" class="settings-note">Запускается та же производственная угроза, что в обычной игре. Нейросеть управляет тактическим движением и разрешением огня, а физика, урон, цели и правила боя остаются серверными. Водный ограничитель не даёт катерам выйти на сушу, но сам по себе не делает модель умной. После завершения вернётся прежний мир без изменения прогресса.</p>
    <div class="settings-grid">
      <button id="neuralThreatLevelButton" type="button" aria-describedby="neuralTestDescription"></button>
      <button id="neuralOnlyStartButton" type="button" class="primary" aria-describedby="neuralTestDescription">Запустить угрозу — только нейросеть</button>
      <button id="neuralOnlyFinishButton" type="button" aria-describedby="neuralTestDescription" disabled>Завершить нейронный бой</button>
      <button id="neuralDownloadBattleButton" type="button" aria-describedby="neuralTestDescription">Скачать записи нейронных боёв</button>
    </div>
    <p id="neuralTestStatus" class="settings-note" role="status" aria-live="polite">Тестовый бой не запущен.</p>
  `;
  card.insertBefore(section, closeButton);

  const levelButton = root.getElementById("neuralThreatLevelButton");
  const startButton = root.getElementById("neuralOnlyStartButton");
  const finishButton = root.getElementById("neuralOnlyFinishButton");
  const downloadButton = root.getElementById("neuralDownloadBattleButton");
  const status = root.getElementById("neuralTestStatus");

  function renderLevel() {
    levelButton.textContent = `Уровень угрозы нейросети: ${level}`;
    levelButton.setAttribute("aria-label", `Уровень угрозы нейросети ${level}. Нажми, чтобы выбрать следующий уровень.`);
  }

  function renderButtons() {
    levelButton.disabled = busy;
    startButton.disabled = busy;
    finishButton.disabled = busy || !active;
    downloadButton.disabled = busy || (!active && archiveEpisodes <= 0);
    startButton.textContent = active
      ? "Перезапустить угрозу — только нейросеть"
      : "Запустить угрозу — только нейросеть";
    downloadButton.textContent = active
      ? "Завершить и скачать архив с этим боем"
      : `Скачать записи нейронных боёв${archiveEpisodes > 0 ? `: ${archiveEpisodes}` : ""}`;
  }

  function setBusy(value) {
    busy = Boolean(value);
    renderButtons();
  }

  function requireRoom() {
    const roomId = currentRoomId();
    if (!roomId) throw new Error("Сначала войди в свободный мир, затем открой настройки игры.");
    return roomId;
  }

  async function refreshStatus() {
    const roomId = currentRoomId();
    if (!roomId) {
      active = false;
      archiveEpisodes = 0;
      status.textContent = "Сначала войди в свободный мир.";
      renderButtons();
      return;
    }
    try {
      const data = await requestJson(`/api/training/status?room=${encodeURIComponent(roomId)}`);
      const runtime = data.runtime || null;
      active = Boolean(runtime?.trainingActive);
      archiveEpisodes = Math.max(0, Number(data.archive?.episodeCount) || 0);
      status.textContent = statusText(runtime, level);
    } catch (error) {
      status.textContent = `Не удалось проверить нейронный бой: ${error.message}.`;
    }
    renderButtons();
  }

  levelButton.addEventListener("click", () => {
    level = level >= NEURAL_THREAT_MAX ? NEURAL_THREAT_MIN : level + 1;
    storeLevel(level);
    renderLevel();
    announce(`Выбрана угроза ${level} для нейросети.`);
  });

  startButton.addEventListener("click", async () => {
    try {
      setBusy(true);
      const roomId = requireRoom();
      status.textContent = `Запускаю угрозу ${level} только с нейросетью…`;
      const data = await requestJson(`/api/training/start?room=${encodeURIComponent(roomId)}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(neuralTrainingStartBody(level)),
      });
      if (!data.trainingActive || !data.battleActive || !data.neuralOnly || !data.neuralShadow?.controlEnabled) {
        throw new Error("сервер не подтвердил нейронное управление");
      }
      active = true;
      status.textContent = statusText(data, level);
      announce(`Запущена угроза ${data.level || level}. Врагами управляет нейросеть. Бой записывается.`, true);
      root.getElementById("settingsCloseButton")?.click();
      root.getElementById("gameTitle")?.focus();
    } catch (error) {
      active = false;
      const text = `Не удалось запустить нейронный бой: ${error.message}.`;
      status.textContent = text;
      announce(text, true);
    } finally {
      setBusy(false);
    }
  });

  finishButton.addEventListener("click", async () => {
    try {
      setBusy(true);
      const roomId = requireRoom();
      status.textContent = "Завершаю нейронный бой и возвращаю обычный мир…";
      const data = await requestJson(`/api/training/finish?room=${encodeURIComponent(roomId)}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: "{}",
      });
      active = Boolean(data.trainingActive);
      archiveEpisodes += 1;
      status.textContent = statusText(data, level);
      announce("Нейронный бой завершён. Обычный мир восстановлен, запись добавлена в архив.", true);
    } catch (error) {
      const text = `Не удалось завершить нейронный бой: ${error.message}.`;
      status.textContent = text;
      announce(text, true);
    } finally {
      setBusy(false);
    }
  });

  downloadButton.addEventListener("click", async () => {
    try {
      setBusy(true);
      const roomId = requireRoom();
      if (active) {
        status.textContent = "Завершаю текущий бой, сохраняю запись и собираю архив…";
        await requestJson(`/api/training/finish?room=${encodeURIComponent(roomId)}`, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: "{}",
        });
        active = false;
        archiveEpisodes += 1;
      } else {
        status.textContent = "Собираю архив записанных боёв…";
      }
      await downloadArchive(roomId);
      status.textContent = "Архив записей передан для скачивания. Внутри manifest.json и отдельный JSONL каждого боя.";
      announce("Архив нейронных боёв скачивается.", true);
    } catch (error) {
      const text = `Не удалось скачать бой: ${error.message}.`;
      status.textContent = text;
      announce(text, true);
    } finally {
      setBusy(false);
    }
  });

  for (const id of ["gameSettingsButton", "lobbySettingsButton"]) {
    root.getElementById(id)?.addEventListener("click", () => setTimeout(refreshStatus, 0));
  }
  root.addEventListener("visibilitychange", () => {
    if (!root.hidden && !root.getElementById("settingsPanel")?.hidden) refreshStatus();
  });

  renderLevel();
  renderButtons();
  return Object.freeze({refreshStatus});
}

if (typeof document !== "undefined") installNeuralTestUi(document);
