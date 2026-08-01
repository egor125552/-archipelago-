"use strict";

(() => {
  const PREFERENCE_KEY = "echo-free-roam-ai-training-settings-v1";
  const DEFAULTS = Object.freeze({level: 2, record: true});
  const $ = id => document.getElementById(id);
  let preferences = readPreferences();
  let busy = false;
  let deleteArmedUntil = 0;
  let syncedRecordingSignature = "";
  let latestStatus = null;

  function readPreferences() {
    try {
      const stored = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || "null");
      return {
        level: [2, 3, 4, 5].includes(Number(stored?.level)) ? Number(stored.level) : DEFAULTS.level,
        record: stored?.record !== false,
      };
    } catch (_) {
      return {...DEFAULTS};
    }
  }

  function savePreferences() {
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences)); } catch (_) {}
  }

  function announce(text, assertive = true) {
    if (!text) return;
    const api = globalThis.__freeRoam;
    const playerIndex = api?.playerIndex?.() ?? 0;
    if (api?.handleEvent && !$("game")?.hidden) {
      api.handleEvent({type: "training-ui", text, targets: [playerIndex]});
      return;
    }
    const message = $("message");
    const live = $("live");
    if (message) message.textContent = text;
    if (live) {
      live.setAttribute("aria-live", assertive ? "assertive" : "polite");
      live.textContent = "";
      requestAnimationFrame(() => { live.textContent = text; });
    }
    const lobbyStatus = $("trainingLobbyStatus");
    if (lobbyStatus) lobbyStatus.textContent = text;
  }

  function levelOptions() {
    return [2, 3, 4, 5].map(level => `<option value="${level}">Угроза ${level} из 5</option>`).join("");
  }

  function injectLobbyControls() {
    if ($("trainingLobbyPanel")) return;
    const rooms = document.querySelector("#lobby .rooms");
    if (!rooms) return;
    const section = document.createElement("section");
    section.id = "trainingLobbyPanel";
    section.className = "rooms";
    section.setAttribute("aria-labelledby", "trainingLobbyTitle");
    section.innerHTML = `
      <h2 id="trainingLobbyTitle">Быстрый бой и обучение ИИ</h2>
      <p>Запускает буквально тот же существующий контрактный бой. Состав врагов, волны, стрельба, смерть и баланс не заменяются тренировочной версией.</p>
      <label for="trainingLevelLobby">Уровень боя</label>
      <select id="trainingLevelLobby">${levelOptions()}</select>
      <div class="lobby-actions">
        <button id="trainingStartLobby" class="primary" type="button">Начать тот же бой сразу</button>
        <button id="trainingRecordLobby" type="button" aria-pressed="true">Запись всех боёв: включена</button>
        <button id="trainingDownloadLobby" type="button">Скачать записи</button>
      </div>
      <p id="trainingLobbyStatus" role="status" aria-live="polite">Проверяю записи…</p>
    `;
    rooms.insertAdjacentElement("beforebegin", section);
  }

  function injectSettingsControls() {
    if ($("trainingSettingsGroup")) return;
    const close = $("settingsCloseButton");
    if (!close) return;
    const section = document.createElement("section");
    section.id = "trainingSettingsGroup";
    section.className = "settings-group";
    section.setAttribute("aria-labelledby", "trainingSettingsTitle");
    section.innerHTML = `
      <h3 id="trainingSettingsTitle">Бои для обучения нейросети</h3>
      <div class="settings-grid">
        <label for="trainingLevelSettings">Быстрый бой</label>
        <select id="trainingLevelSettings">${levelOptions()}</select>
        <button id="trainingRecordSettings" type="button" aria-pressed="true">Запись всех боёв: включена</button>
        <button id="trainingStartSettings" class="primary" type="button">Запустить выбранную угрозу</button>
        <button id="trainingFinishSettings" type="button">Завершить быстрый бой и вернуть обычный мир</button>
        <button id="trainingDownloadSettings" type="button">Скачать архив записей</button>
        <button id="trainingDeleteSettings" type="button">Удалить записи</button>
      </div>
      <p id="trainingSettingsStatus" class="settings-note" role="status" aria-live="polite">Записи хранятся на сервере отдельно от обычного мира. В браузере сохраняются только этот переключатель и выбранный уровень.</p>
    `;
    close.insertAdjacentElement("beforebegin", section);
  }

  function currentRoom() {
    return String(globalThis.__freeRoam?.roomId?.() || "").trim();
  }

  async function primaryRoom() {
    const current = currentRoom();
    if (current) return current;
    const saved = globalThis.__freeRoamSavedWorld?.active?.();
    if (saved?.room) return String(saved.room);
    try {
      const response = await fetch("/api/saved-world", {cache: "no-store"});
      if (!response.ok) return "";
      const data = await response.json();
      return String(data?.primaryRoom || "");
    } catch (_) {
      return "";
    }
  }

  async function waitForConnectedRoom(timeoutMs = 15_000) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const room = currentRoom();
      if (room && globalThis.__freeRoam?.getWorld?.()) return room;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return "";
  }

  async function connectForQuickBattle() {
    const existing = currentRoom();
    if (existing) return existing;
    await globalThis.__freeRoamSavedWorld?.refresh?.();
    const saved = globalThis.__freeRoamSavedWorld?.active?.();
    if (saved?.full) throw new Error("сохранённый мир сейчас занят двумя игроками");
    if (saved?.room) {
      const joined = globalThis.__freeRoamSavedWorld?.join?.();
      if (!joined) throw new Error("не удалось открыть сохранённый мир");
    } else {
      const host = $("hostButton");
      if (!host) throw new Error("кнопка создания мира недоступна");
      host.click();
    }
    const room = await waitForConnectedRoom();
    if (!room) throw new Error("сервер не открыл мир вовремя");
    return room;
  }

  function selectedLevel() {
    const value = Number($("trainingLevelSettings")?.value || $("trainingLevelLobby")?.value || preferences.level);
    return [2, 3, 4, 5].includes(value) ? value : 2;
  }

  function setLevel(level) {
    preferences.level = [2, 3, 4, 5].includes(Number(level)) ? Number(level) : 2;
    savePreferences();
    for (const id of ["trainingLevelLobby", "trainingLevelSettings"]) {
      const select = $(id);
      if (select) select.value = String(preferences.level);
    }
  }

  function syncControls() {
    for (const id of ["trainingLevelLobby", "trainingLevelSettings"]) {
      const select = $(id);
      if (select) select.value = String(preferences.level);
    }
    const recordingText = `Запись всех боёв: ${preferences.record ? "включена" : "выключена"}`;
    for (const id of ["trainingRecordLobby", "trainingRecordSettings"]) {
      const button = $(id);
      if (!button) continue;
      button.textContent = recordingText;
      button.setAttribute("aria-pressed", String(preferences.record));
      button.disabled = busy;
    }
    for (const id of ["trainingStartLobby", "trainingStartSettings", "trainingDownloadLobby", "trainingDownloadSettings", "trainingDeleteSettings"]) {
      if ($(id)) $(id).disabled = busy;
    }
    const finish = $("trainingFinishSettings");
    if (finish) finish.disabled = busy || !latestStatus?.runtime?.trainingActive;
  }

  async function postJson(path, room, body = {}) {
    const response = await fetch(`${path}?room=${encodeURIComponent(room)}`, {
      method: "POST",
      cache: "no-store",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }

  async function syncRecordingPreference(room = currentRoom()) {
    if (!room) return;
    const signature = `${room}:${preferences.record}`;
    if (signature === syncedRecordingSignature) return;
    await postJson("/api/training/recording", room, {enabled: preferences.record});
    syncedRecordingSignature = signature;
  }

  async function startQuickBattle() {
    if (busy) return;
    busy = true;
    setLevel(selectedLevel());
    syncControls();
    announce(`Открываю мир и запускаю существующую угрозу ${preferences.level} без доставки ящиков.`, false);
    try {
      const room = await connectForQuickBattle();
      await syncRecordingPreference(room);
      const data = await postJson("/api/training/start", room, {
        level: preferences.level,
        record: preferences.record,
      });
      latestStatus = {runtime: data, archive: latestStatus?.archive || null};
      globalThis.__freeRoamSettings?.close?.();
      announce(`Запущена угроза ${preferences.level}. Это тот же боевой код и тот же баланс, только без предварительных доставок.`, true);
      await refreshStatus(room);
    } catch (error) {
      announce(`Быстрый бой не запущен: ${error.message}.`, true);
    } finally {
      busy = false;
      syncControls();
    }
  }

  async function finishQuickBattle() {
    if (busy) return;
    const room = currentRoom();
    if (!room) {
      announce("Сейчас нет подключённого мира.", true);
      return;
    }
    busy = true;
    syncControls();
    try {
      await postJson("/api/training/finish", room, {});
      announce("Быстрый бой завершён. Обычный мир возвращён без изменений.", true);
      await refreshStatus(room);
    } catch (error) {
      announce(`Не удалось вернуть обычный мир: ${error.message}.`, true);
    } finally {
      busy = false;
      syncControls();
    }
  }

  async function toggleRecording() {
    preferences.record = !preferences.record;
    savePreferences();
    syncedRecordingSignature = "";
    syncControls();
    const room = currentRoom();
    try {
      if (room) await syncRecordingPreference(room);
      announce(`Запись боёв для обучения ${preferences.record ? "включена" : "выключена"}.`, false);
    } catch (error) {
      announce(`Настройка сохранена в браузере, но сервер пока не принял её: ${error.message}.`, true);
    }
  }

  function statusText(data) {
    const archive = data?.archive || {};
    const runtime = data?.runtime || {};
    const sizeMb = ((Number(archive.totalBytes) || 0) / 1024 / 1024).toFixed(1).replace(".0", "");
    const battle = runtime.trainingActive
      ? runtime.battleActive
        ? ` Сейчас идёт быстрый бой угрозы ${runtime.level}${runtime.recording ? `; записано кадров ${runtime.frames}` : "; запись выключена"}.`
        : ` Быстрый бой угрозы ${runtime.level} закончен; обычный мир можно вернуть кнопкой.`
      : "";
    return `Записано боёв: ${archive.episodeCount || 0}. Размер: ${sizeMb} МБ.${battle}`;
  }

  async function refreshStatus(room = "") {
    const targetRoom = room || await primaryRoom();
    if (!targetRoom) {
      latestStatus = null;
      const text = "Сохранённого мира и записей пока нет.";
      if ($("trainingLobbyStatus")) $("trainingLobbyStatus").textContent = text;
      if ($("trainingSettingsStatus")) $("trainingSettingsStatus").textContent = text;
      syncControls();
      return null;
    }
    try {
      const response = await fetch(`/api/training/status?room=${encodeURIComponent(targetRoom)}`, {cache: "no-store"});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      latestStatus = await response.json();
      const text = statusText(latestStatus);
      if ($("trainingLobbyStatus")) $("trainingLobbyStatus").textContent = text;
      if ($("trainingSettingsStatus")) $("trainingSettingsStatus").textContent = text;
      if (currentRoom()) await syncRecordingPreference(currentRoom());
      syncControls();
      return latestStatus;
    } catch (error) {
      const text = `Не удалось проверить записи: ${error.message}.`;
      if ($("trainingLobbyStatus")) $("trainingLobbyStatus").textContent = text;
      if ($("trainingSettingsStatus")) $("trainingSettingsStatus").textContent = text;
      return null;
    }
  }

  function filenameFromResponse(response, room) {
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    return match?.[1] || `echo-ai-training-${room}.zip`;
  }

  async function downloadArchive() {
    if (busy) return;
    busy = true;
    syncControls();
    try {
      const room = await primaryRoom();
      if (!room) throw new Error("нет мира, к которому относятся записи");
      const response = await fetch(`/api/training/archive?room=${encodeURIComponent(room)}`, {cache: "no-store"});
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error === "No recorded battles" ? "записанных боёв пока нет" : data?.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFromResponse(response, room);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15_000);
      announce(`Архив готов. В нём ${latestStatus?.archive?.episodeCount || "записанные"} боёв.`, false);
    } catch (error) {
      announce(`Архив не скачан: ${error.message}.`, true);
    } finally {
      busy = false;
      syncControls();
    }
  }

  async function deleteArchive() {
    const now = Date.now();
    if (now > deleteArmedUntil) {
      deleteArmedUntil = now + 6_000;
      announce("Нажми «Удалить записи» ещё раз в течение шести секунд для подтверждения.", true);
      return;
    }
    deleteArmedUntil = 0;
    if (busy) return;
    busy = true;
    syncControls();
    try {
      const room = await primaryRoom();
      if (!room) throw new Error("записей пока нет");
      const response = await fetch(`/api/training/archive?room=${encodeURIComponent(room)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      announce("Все сохранённые записи боёв удалены.", true);
      await refreshStatus(room);
    } catch (error) {
      announce(`Записи не удалены: ${error.message}.`, true);
    } finally {
      busy = false;
      syncControls();
    }
  }

  function bind() {
    injectLobbyControls();
    injectSettingsControls();
    for (const id of ["trainingLevelLobby", "trainingLevelSettings"]) {
      $(id)?.addEventListener("change", event => setLevel(Number(event.target.value)));
    }
    $("trainingStartLobby")?.addEventListener("click", startQuickBattle);
    $("trainingStartSettings")?.addEventListener("click", startQuickBattle);
    $("trainingFinishSettings")?.addEventListener("click", finishQuickBattle);
    $("trainingRecordLobby")?.addEventListener("click", toggleRecording);
    $("trainingRecordSettings")?.addEventListener("click", toggleRecording);
    $("trainingDownloadLobby")?.addEventListener("click", downloadArchive);
    $("trainingDownloadSettings")?.addEventListener("click", downloadArchive);
    $("trainingDeleteSettings")?.addEventListener("click", deleteArchive);
    syncControls();
    refreshStatus().catch(() => {});
    setInterval(() => {
      const room = currentRoom();
      if (room || !$("lobby")?.hidden) refreshStatus(room).catch(() => {});
    }, 4_000);
  }

  bind();

  globalThis.__freeRoamTraining = {
    start: level => {
      if ([2, 3, 4, 5].includes(Number(level))) setLevel(Number(level));
      startQuickBattle().catch(() => {});
    },
    finish: () => finishQuickBattle().catch(() => {}),
    status: () => latestStatus,
    refresh: () => refreshStatus(),
    recordingEnabled: () => preferences.record,
  };
})();
