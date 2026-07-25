"use strict";

(() => {
  const SAVED_WORLD_KEY = "echo-free-roam-saved-world-v2";
  const LEGACY_SESSION_KEY = "echo-free-roam-active-session-v1";
  const INTERFACE_SETTINGS_KEY = "echo-free-roam-interface-settings-v1";
  const NativeWebSocket = globalThis.WebSocket;

  let savedWorld = migrateSavedWorld();
  let pendingSavedJoin = false;
  let createNewPending = false;
  let bypassCreateGuard = false;

  function validSession(value) {
    return Boolean(value?.room && ["captain", "crew"].includes(value.role));
  }

  function readJson(storage, key) {
    try { return JSON.parse(storage.getItem(key) || "null"); }
    catch (_) { return null; }
  }

  function migrateSavedWorld() {
    const stored = readJson(localStorage, SAVED_WORLD_KEY);
    const legacy = readJson(sessionStorage, LEGACY_SESSION_KEY);
    const result = validSession(stored) ? stored : validSession(legacy) ? legacy : null;
    if (result) {
      try {
        localStorage.setItem(SAVED_WORLD_KEY, JSON.stringify({
          room: String(result.room),
          role: result.role,
          savedAt: Number(result.savedAt) || Date.now(),
        }));
      } catch (_) {}
    }
    try { sessionStorage.removeItem(LEGACY_SESSION_KEY); } catch (_) {}
    return result && {
      room: String(result.room),
      role: result.role,
      savedAt: Number(result.savedAt) || Date.now(),
    };
  }

  async function savedWorldStatus(room = "") {
    try {
      const query = room ? `?room=${encodeURIComponent(room)}` : "";
      const response = await fetch(`/api/saved-world${query}`, {cache: "no-store"});
      if (!response.ok) return null;
      return response.json();
    } catch (_) {
      return null;
    }
  }

  async function saveWorld(room, role) {
    if (!room || !["captain", "crew"].includes(role)) return false;
    const status = await savedWorldStatus(room);
    if (!status?.primary || !status?.exists) {
      if (savedWorld?.room === String(room)) clearSavedWorld();
      return false;
    }
    savedWorld = {room: String(room), role, savedAt: Date.now()};
    try { localStorage.setItem(SAVED_WORLD_KEY, JSON.stringify(savedWorld)); } catch (_) {}
    syncButtons();
    return true;
  }

  function clearSavedWorld() {
    savedWorld = null;
    pendingSavedJoin = false;
    try { localStorage.removeItem(SAVED_WORLD_KEY); } catch (_) {}
    try { sessionStorage.removeItem(LEGACY_SESSION_KEY); } catch (_) {}
    syncButtons();
  }

  async function validateSavedWorld() {
    if (!savedWorld) return false;
    const status = await savedWorldStatus(savedWorld.room);
    if (!status?.primary || !status?.exists) {
      clearSavedWorld();
      return false;
    }
    return true;
  }

  function autoResumeEnabled() {
    try {
      const settings = JSON.parse(localStorage.getItem(INTERFACE_SETTINGS_KEY) || "null");
      return settings?.autoResume === true;
    } catch (_) {
      return false;
    }
  }

  function announce(text, assertive = true) {
    const message = document.getElementById("message");
    const live = document.getElementById("live");
    if (message) message.textContent = text;
    if (live) {
      live.setAttribute("aria-live", assertive ? "assertive" : "polite");
      live.textContent = "";
      requestAnimationFrame(() => { live.textContent = text; });
    }
  }

  function syncButtons() {
    const host = document.getElementById("hostButton");
    const join = document.getElementById("joinButton");
    if (host) host.textContent = savedWorld ? "Создать новый мир и удалить сохранённый" : "Создать новый мир";
    if (join) {
      join.textContent = "Войти в ближайший мир";
      join.dataset.savedRoom = "";
    }

    let resume = document.getElementById("resumeSavedButton");
    if (!resume && join) {
      resume = document.createElement("button");
      resume.id = "resumeSavedButton";
      resume.type = "button";
      join.insertAdjacentElement("afterend", resume);
    }
    if (resume) {
      resume.hidden = !savedWorld;
      resume.textContent = savedWorld
        ? `Вернуться в сохранённый мир ${savedWorld.room}`
        : "Вернуться в сохранённый мир";
    }
  }

  function rewriteSavedWorldUrl(input) {
    if (!pendingSavedJoin || !savedWorld) return input;
    try {
      const url = new URL(String(input), location.href);
      if (url.pathname !== "/api/connect" || url.searchParams.get("mode") !== "free") return input;
      url.searchParams.set("room", savedWorld.room);
      url.searchParams.set("role", savedWorld.role);
      pendingSavedJoin = false;
      return url.toString();
    } catch (_) {
      return input;
    }
  }

  function SavedWorldWebSocket(url, protocols) {
    const finalUrl = rewriteSavedWorldUrl(url);
    const socket = protocols === undefined
      ? new NativeWebSocket(finalUrl)
      : new NativeWebSocket(finalUrl, protocols);

    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === "lobby-ready" && message.room && ["captain", "crew"].includes(message.role)) {
          saveWorld(message.room, message.role).catch(() => {});
        }
      } catch (_) {}
    });
    return socket;
  }

  if (typeof NativeWebSocket === "function") {
    SavedWorldWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(SavedWorldWebSocket, NativeWebSocket);
    globalThis.WebSocket = SavedWorldWebSocket;
  }

  async function deleteOldWorldAndCreate(hostButton) {
    if (!savedWorld || createNewPending) return;
    createNewPending = true;
    const oldRoom = savedWorld.room;
    announce(`Удаляю сохранённый мир ${oldRoom} и создаю новый.`, true);
    try {
      const response = await fetch(`/api/saved-world?room=${encodeURIComponent(oldRoom)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      clearSavedWorld();
      bypassCreateGuard = true;
      hostButton.click();
      bypassCreateGuard = false;
    } catch (error) {
      announce(`Сохранённый мир не удалён: ${error.message}. Новый мир не создан, чтобы не потерять прогресс.`, true);
    } finally {
      createNewPending = false;
      bypassCreateGuard = false;
    }
  }

  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    const host = target?.closest("#hostButton");
    if (host && savedWorld && !bypassCreateGuard) {
      event.preventDefault();
      event.stopImmediatePropagation();
      deleteOldWorldAndCreate(host);
      return;
    }

    const resume = target?.closest("#resumeSavedButton");
    if (resume && savedWorld) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingSavedJoin = true;
      document.getElementById("joinButton")?.click();
    }
  }, true);

  function autoResumeSavedWorld() {
    if (!savedWorld || !autoResumeEnabled()) return;
    const lobby = document.getElementById("lobby");
    const join = document.getElementById("joinButton");
    const resume = document.getElementById("resumeSavedButton");
    if (!globalThis.__freeRoam || !join || !resume || join.disabled || lobby?.hidden) {
      setTimeout(autoResumeSavedWorld, 80);
      return;
    }
    resume.click();
  }

  syncButtons();
  validateSavedWorld().then(valid => {
    if (valid && autoResumeEnabled()) setTimeout(autoResumeSavedWorld, 0);
  });

  globalThis.__freeRoamSavedWorld = {
    active: () => savedWorld ? {...savedWorld} : null,
    clear: clearSavedWorld,
    save: saveWorld,
    join: () => {
      if (!savedWorld) return false;
      document.getElementById("resumeSavedButton")?.click();
      return true;
    },
  };
})();
