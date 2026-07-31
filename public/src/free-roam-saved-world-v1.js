"use strict";

(() => {
  const INTERFACE_SETTINGS_KEY = "echo-free-roam-interface-settings-v1";
  const NativeWebSocket = globalThis.WebSocket;

  let savedWorld = null;
  let serverState = "loading";
  let pendingSavedJoin = false;
  let createNewPending = false;
  let bypassCreateGuard = false;

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

  async function waitingRoleForRoom(room) {
    try {
      const response = await fetch("/api/rooms?mode=free", {cache: "no-store"});
      if (!response.ok) return null;
      const data = await response.json();
      const entry = Array.isArray(data?.rooms)
        ? data.rooms.find(item => String(item?.id || "") === String(room))
        : null;
      return ["captain", "crew"].includes(entry?.waitingFor) ? entry.waitingFor : null;
    } catch (_) {
      return null;
    }
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

  function clearSavedWorld() {
    savedWorld = null;
    pendingSavedJoin = false;
    syncButtons();
  }

  async function refreshSavedWorld() {
    serverState = "loading";
    const primaryStatus = await savedWorldStatus();
    if (!primaryStatus) {
      serverState = "error";
      syncButtons();
      return false;
    }

    const room = String(primaryStatus.primaryRoom || "").trim();
    if (!room) {
      savedWorld = null;
      serverState = "ready";
      syncButtons();
      return true;
    }

    const status = await savedWorldStatus(room);
    if (!status) {
      serverState = "error";
      syncButtons();
      return false;
    }
    if (!status.primary || !status.exists) {
      savedWorld = null;
      serverState = "ready";
      syncButtons();
      return true;
    }

    let role = "captain";
    let full = false;
    if (status.online) {
      const waitingRole = await waitingRoleForRoom(room);
      if (waitingRole) role = waitingRole;
      else {
        role = null;
        full = true;
      }
    }

    savedWorld = {room, role, full};
    serverState = "ready";
    syncButtons();
    return true;
  }

  async function saveWorld(room, role) {
    if (!room || !["captain", "crew"].includes(role)) return false;
    const status = await savedWorldStatus(room);
    if (!status?.primary || !status?.exists) {
      if (savedWorld?.room === String(room)) clearSavedWorld();
      return false;
    }
    savedWorld = {room: String(room), role, full: false};
    serverState = "ready";
    syncButtons();
    return true;
  }

  function syncButtons() {
    const host = document.getElementById("hostButton");
    const join = document.getElementById("joinButton");
    if (host) {
      host.textContent = savedWorld
        ? "Создать новый мир и удалить сохранённый"
        : "Создать новый мир";
    }
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
      if (savedWorld?.full) {
        resume.textContent = `Проверить сохранённый мир ${savedWorld.room}: сейчас заняты оба места`;
      } else {
        resume.textContent = savedWorld
          ? `Вернуться в сохранённый мир ${savedWorld.room}`
          : "Вернуться в сохранённый мир";
      }
    }
  }

  function rewriteSavedWorldUrl(input) {
    if (!pendingSavedJoin || !savedWorld || !["captain", "crew"].includes(savedWorld.role)) return input;
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

  async function ensureServerState() {
    if (serverState === "ready") return true;
    return refreshSavedWorld();
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

  async function createWorldSafely(hostButton) {
    if (createNewPending) return;
    const ready = await ensureServerState();
    if (!ready) {
      announce("Не удалось проверить сохранённый мир на сервере. Новый мир не создан, чтобы случайно не потерять прогресс.", true);
      return;
    }
    if (savedWorld) {
      await deleteOldWorldAndCreate(hostButton);
      return;
    }
    bypassCreateGuard = true;
    hostButton.click();
    bypassCreateGuard = false;
  }

  async function joinSavedWorld() {
    const ready = await refreshSavedWorld();
    if (!ready) {
      announce("Не удалось получить сохранённый мир с сервера. Проверь соединение и попробуй ещё раз.", true);
      return false;
    }
    if (!savedWorld) {
      announce("На сервере сейчас нет сохранённого мира.", true);
      return false;
    }
    if (savedWorld.full || !["captain", "crew"].includes(savedWorld.role)) {
      announce("Сохранённый мир сейчас занят двумя игроками. Попробуй войти позже.", true);
      return false;
    }
    pendingSavedJoin = true;
    document.getElementById("joinButton")?.click();
    return true;
  }

  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    const host = target?.closest("#hostButton");
    if (host && !bypassCreateGuard) {
      event.preventDefault();
      event.stopImmediatePropagation();
      createWorldSafely(host).catch(() => {});
      return;
    }

    const resume = target?.closest("#resumeSavedButton");
    if (resume) {
      event.preventDefault();
      event.stopImmediatePropagation();
      joinSavedWorld().catch(() => {});
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
    joinSavedWorld().catch(() => {});
  }

  syncButtons();
  refreshSavedWorld().then(ready => {
    // Give a reloaded page a moment for the old WebSocket close to reach the
    // server. No browser-side room or role marker is used for the reconnect.
    if (ready && savedWorld && autoResumeEnabled()) setTimeout(autoResumeSavedWorld, 700);
  });

  globalThis.__freeRoamSavedWorld = {
    active: () => savedWorld ? {...savedWorld} : null,
    clear: clearSavedWorld,
    refresh: refreshSavedWorld,
    save: saveWorld,
    join: () => {
      joinSavedWorld().catch(() => {});
      return Boolean(savedWorld);
    },
  };
})();
