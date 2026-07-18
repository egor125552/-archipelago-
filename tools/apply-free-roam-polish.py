from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


def append_once(path, marker, content):
    p = Path(path)
    text = p.read_text()
    if marker in text:
        return
    p.write_text(text.rstrip() + "\n\n" + content.strip() + "\n")


# Client: reconnect to the exact listed room, keep the room alive and report races truthfully.
replace_once(
    "public/src/free-roam-v3.js",
    'let roomRefreshTimer = 0;\nlet socket = null;',
    'let roomRefreshTimer = 0;\nlet heartbeatTimer = 0;\nlet preferredRoomId = "";\nlet socket = null;',
)
replace_once(
    "public/src/free-roam-v3.js",
    '''function socketUrl(role) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/connect?role=${role}&mode=free`;
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
''',
    '''function socketUrl(role) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/connect`);
  url.searchParams.set("role", role);
  url.searchParams.set("mode", "free");
  if (role === "auto" && preferredRoomId) url.searchParams.set("room", preferredRoomId);
  return url.toString();
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
}

function startHeartbeat() {
  stopHeartbeat();
  send({type: "heartbeat", at: Date.now()});
  heartbeatTimer = setInterval(() => send({type: "heartbeat", at: Date.now()}), 4_000);
}
''',
)
replace_once(
    "public/src/free-roam-v3.js",
    '  socket = new WebSocket(socketUrl(role));\n  socket.addEventListener("message", event => {',
    '  socket = new WebSocket(socketUrl(role));\n  socket.addEventListener("open", startHeartbeat);\n  socket.addEventListener("message", event => {',
)
replace_once(
    "public/src/free-roam-v3.js",
    '''          : requestedRole === "auto"
            ? "Свободных миров не было. Создан новый мир; ждём второго игрока."
            : "Мир создан. Можно ездить одному; ждём второго игрока.";''',
    '''          : requestedRole === "auto"
            ? message.replacedStale
              ? "Ожидавший мир уже закрылся до подключения. Создан новый мир; ждём второго игрока."
              : "Свободных миров не было. Создан новый мир; ждём второго игрока."
            : "Мир создан. Можно ездить одному; ждём второго игрока.";''',
)
replace_once(
    "public/src/free-roam-v3.js",
    '''  socket.addEventListener("close", () => {
    if ($("game").hidden) resetButtons();
  });''',
    '''  socket.addEventListener("close", () => {
    stopHeartbeat();
    if ($("game").hidden) resetButtons();
  });''',
)
replace_once(
    "public/src/free-roam-v3.js",
    '''function leaveGame() {
  releaseAllMovement();
  audio.stopAll();''',
    '''function leaveGame() {
  releaseAllMovement();
  stopHeartbeat();
  audio.stopAll();''',
)
replace_once(
    "public/src/free-roam-v3.js",
    '''    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    $("roomsSummary").textContent = rooms.length ? `Свободных миров: ${rooms.length}.` : "Свободных миров нет. Кнопка входа создаст ожидание первого игрока.";
    $("roomsList").replaceChildren(...rooms.map((room, index) => {''',
    '''    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    preferredRoomId = rooms[0]?.id || "";
    if (!rooms.length) {
      $("roomsSummary").textContent = "Сейчас нет ожидающих миров. Кнопка входа создаст новый мир.";
    } else if (rooms[0].waitingFor === "captain") {
      $("roomsSummary").textContent = `Миров: ${rooms.length}. Ближайший ждёт создателя; кнопка входа займёт его место.`;
    } else {
      $("roomsSummary").textContent = `Миров: ${rooms.length}. Ближайший ждёт второго игрока.`;
    }
    $("joinButton").textContent = rooms.length ? "Войти в ближайший мир" : "Создать или ждать игрока";
    $("roomsList").replaceChildren(...rooms.map((room, index) => {''',
)
replace_once(
    "public/src/free-roam-v3.js",
    '''  audioDiagnostics: () => globalThis.__freeRoamAudioDiagnostics || null,
};''',
    '''  audioDiagnostics: () => globalThis.__freeRoamAudioDiagnostics || null,
  roomId: () => roomId,
  preferredRoom: () => preferredRoomId,
  handleEvent: event => handleGameEvent(event),
};''',
)

# One tow solver only. v5 owns the spring/turning constraint.
replace_once(
    "public/src/free-roam-core-v2.js",
    '''function updateTow(world, dt) {
  const tow = world.tow;''',
    '''function updateTow(world, dt) {
  if ((Number(world.version) || 0) >= 5) return;
  const tow = world.tow;''',
)

# Audible finite outer water boundary for boats.
replace_once(
    "public/src/free-roam-core-v5.js",
    '''  world.freeMeta ||= {
    boundaryAt: Array.from({length: world.players?.length || 2}, () => -999),
    waterBoundaryAt: Array.from({length: world.players?.length || 2}, () => -999),
  };''',
    '''  world.freeMeta ||= {
    boundaryAt: Array.from({length: world.players?.length || 2}, () => -999),
    waterBoundaryAt: Array.from({length: world.players?.length || 2}, () => -999),
    boatBoundaryAt: Array.from({length: world.boats?.length || 2}, () => -999),
  };
  world.freeMeta.boatBoundaryAt ||= Array.from({length: world.boats?.length || 2}, () => -999);''',
)
replace_once(
    "public/src/free-roam-core-v5.js",
    '''  while (world.freeMeta.waterBoundaryAt.length < world.players.length) world.freeMeta.waterBoundaryAt.push(-999);
  for (const player of world.players || []) {''',
    '''  while (world.freeMeta.waterBoundaryAt.length < world.players.length) world.freeMeta.waterBoundaryAt.push(-999);
  while (world.freeMeta.boatBoundaryAt.length < world.boats.length) world.freeMeta.boatBoundaryAt.push(-999);
  for (const player of world.players || []) {''',
)
replace_once(
    "public/src/free-roam-core-v5.js",
    '''function enrichMovementEvents(world, eventStart) {''',
    '''function processBoatBoundaries(world) {
  const minX = WORLD.boatRadius + 0.05;
  const maxX = WORLD.width - WORLD.boatRadius - 0.05;
  const maxY = WORLD.height - WORLD.boatRadius - 0.05;
  for (let index = 0; index < world.boats.length; index += 1) {
    const boat = world.boats[index];
    if (!boat || boat.sunk) continue;
    const velocity = boatVelocity(boat);
    let side = null;
    let inwardHeading = boat.heading;
    if (boat.x <= minX && velocity.x < -0.08) {
      side = "left";
      inwardHeading = 90;
    } else if (boat.x >= maxX && velocity.x > 0.08) {
      side = "right";
      inwardHeading = -90;
    } else if (boat.y >= maxY && velocity.y > 0.08) {
      side = "open-water";
      inwardHeading = 0;
    }
    if (!side) continue;

    boat.x = clamp(boat.x, minX + 1.4, maxX - 1.4);
    boat.y = clamp(boat.y, WORLD.shoreY + 4, maxY - 1.4);
    boat.speed *= -0.18;
    boat.throttle = 0;
    boat.heading = approachAngle(boat.heading, inwardHeading, 58);
    if (world.time - world.freeMeta.boatBoundaryAt[index] < 1.1) continue;
    world.freeMeta.boatBoundaryAt[index] = world.time;
    const target = boat.driver ?? boat.owner;
    emit(world, "water-boundary", "Граница бухты. Дальше открытая вода недоступна; разворачивайся.", [target], {
      sourcePlayer: target,
      x: boat.x,
      y: boat.y,
      side,
      pan: side === "left" ? -0.9 : side === "right" ? 0.9 : 0,
    });
  }
}

function enrichMovementEvents(world, eventStart) {''',
)
replace_once(
    "public/src/free-roam-core-v5.js",
    '''  processJumpArc(world, eventStart, safeDt);
  processBoundaries(world);
  processTowPhysics(world, safeDt);''',
    '''  processJumpArc(world, eventStart, safeDt);
  processBoundaries(world);
  processBoatBoundaries(world);
  processTowPhysics(world, safeDt);''',
)

# Distance attenuation for rope and landing sounds.
replace_once(
    "public/src/free-roam-audio-v4.js",
    '''const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
''',
    '''const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

export function spatialGainForDistance(metres, maximum = 120) {
  const proximity = clamp(1 - (Number(metres) || 0) / maximum, 0, 1);
  return Math.pow(proximity, 1.45);
}
''',
)
replace_once(
    "public/src/free-roam-audio-v4.js",
    '''    if (event.type === "landing") {
      const pan = this.eventPan(event);
      const local = event.sourcePlayer === playerIndex;
      this.playFootstep({gain: local ? 0.34 : 0.18, rate: 0.82, pan});
      if (this.buffers.has("hullCreak")) this.play("hullCreak", {gain: local ? 0.11 : 0.06, rate: 1.1, pan, lowpass: 3800});
      return;
    }''',
    '''    if (event.type === "landing") {
      const pan = this.eventPan(event);
      const local = event.sourcePlayer === playerIndex;
      const metres = local || !this.listenerPoint ? 0 : distance(this.listenerPoint, event);
      const falloff = local ? 1 : spatialGainForDistance(metres, 82);
      const gain = (local ? 0.34 : 0.18) * falloff;
      if (gain <= 0.004) return;
      this.playFootstep({gain, rate: 0.82, pan});
      if (this.buffers.has("hullCreak")) this.play("hullCreak", {gain: (local ? 0.11 : 0.06) * falloff, rate: 1.1, pan, lowpass: 1800 + falloff * 2000});
      return;
    }''',
)
replace_once(
    "public/src/free-roam-audio-v4.js",
    '''    if (event.type === "tow-creak" || event.type === "tow-strain") {
      const pan = this.eventPan(event);
      const tension = clamp(Number(event.tension) || 0, 0, 1.45);
      const gain = 0.08 + tension * 0.18;
      this.spatialDiagnostics.towPan = pan;
      this.spatialDiagnostics.towGain = gain;
      if (event.type === "tow-strain") {
        this.handle([{type: "rope-strain", speed: tension, pan}]);
      } else if (this.buffers.has("hullCreak")) {
        this.play("hullCreak", {gain, rate: 0.74 + tension * 0.16, pan, lowpass: 3000 + tension * 2200});
      }
      return;
    }''',
    '''    if (event.type === "tow-creak" || event.type === "tow-strain") {
      const pan = this.eventPan(event);
      const tension = clamp(Number(event.tension) || 0, 0, 1.45);
      const metres = this.listenerPoint ? distance(this.listenerPoint, event) : 0;
      const falloff = spatialGainForDistance(metres, 135);
      const gain = (0.08 + tension * 0.18) * falloff;
      this.spatialDiagnostics.towPan = pan;
      this.spatialDiagnostics.towGain = gain;
      if (gain <= 0.004) return;
      if (event.type === "tow-strain") {
        this.handle([{type: "rope-strain", speed: tension, pan, gain}]);
      } else if (this.buffers.has("hullCreak")) {
        this.play("hullCreak", {gain, rate: 0.74 + tension * 0.16, pan, lowpass: 1600 + falloff * (1400 + tension * 2200)});
      }
      return;
    }''',
)

replace_once(
    "public/free-roam.html",
    '<script type="module" src="src/free-roam-v3.js?v=5"></script>',
    '<script type="module" src="src/free-roam-v3.js?v=6"></script>',
)

# Core regression tests.
append_once(
    "tests/free-roam-core-v5.test.mjs",
    'test("boats hit an audible finite outer boundary"',
    '''test("boats hit an audible finite outer boundary", () => {
  const world = createFreeWorld();
  const boat = world.boats[0];
  boat.x = WORLD.width - WORLD.boatRadius - 0.01;
  boat.y = 190;
  boat.heading = 90;
  boat.speed = 12;
  boat.throttle = 1;
  drainEvents(world);

  stepMany(world, 0.25);
  assert.ok(boat.x < WORLD.width - WORLD.boatRadius, boat.x);
  assert.ok(Math.abs(boat.speed) < 4, boat.speed);
  assert.equal(boat.throttle, 0);
  assert.ok(drainEvents(world).some(event => event.type === "water-boundary"));
});

test("the v5 rope is solved once and survives turns in both directions", () => {
  const world = createFreeWorld();
  setPlayerInput(world, 0, {action: true});
  stepFreeWorld(world, 0.05);
  setPlayerInput(world, 0, {action: false, up: true, right: true});
  stepMany(world, 2.4);
  assert.ok(world.tow);
  const rightHeading = world.boats[1].heading;

  setPlayerInput(world, 0, {up: true, left: true});
  stepMany(world, 3.4);
  assert.ok(world.tow, "ordinary S-turn must not snap the rope");
  const metres = Math.hypot(world.boats[0].x - world.boats[1].x, world.boats[0].y - world.boats[1].y);
  assert.ok(metres <= WORLD.towMaximumLength, metres);
  assert.notEqual(world.boats[1].heading, rightHeading);
  assert.ok(world.tow.tension <= 1.45);
});''',
)

# Browser regression tests for exact-room reconnect, stale-room race, boat boundary and rope audio falloff.
replace_once(
    "tests/free-roam.e2e.spec.mjs",
    '''    await expect.poll(() => crew.evaluate(async () => {
      const response = await fetch("/api/rooms?mode=free", {cache: "no-store"});
      const data = await response.json();
      return data.rooms?.[0]?.waitingFor || null;
    })).toBe("captain");

    await newcomer.getByRole("button", {name: "Войти в ближайший мир"}).click();''',
    '''    const waitingRoom = await expect.poll(() => crew.evaluate(async () => {
      const response = await fetch("/api/rooms?mode=free", {cache: "no-store"});
      const data = await response.json();
      return data.rooms?.[0] || null;
    })).not.toBeNull();
    await expect.poll(() => crew.evaluate(async () => {
      const response = await fetch("/api/rooms?mode=free", {cache: "no-store"});
      const data = await response.json();
      return data.rooms?.[0]?.waitingFor || null;
    })).toBe("captain");
    await newcomer.getByRole("button", {name: "Обновить"}).click();
    const expectedRoom = await newcomer.evaluate(() => window.__freeRoam.preferredRoom());
    expect(expectedRoom).toBeTruthy();

    await newcomer.getByRole("button", {name: "Войти в ближайший мир"}).click();''',
)
replace_once(
    "tests/free-roam.e2e.spec.mjs",
    '''    await expect.poll(() => newcomer.evaluate(() => window.__freeRoam?.isHost?.())).toBe(true);
    await expect.poll(() => crew.evaluate(() => window.__freeRoam?.getWorld()?.players?.length || 0)).toBe(2);''',
    '''    await expect.poll(() => newcomer.evaluate(() => window.__freeRoam?.isHost?.())).toBe(true);
    expect(await newcomer.evaluate(() => window.__freeRoam.roomId())).toBe(expectedRoom);
    await expect.poll(() => crew.evaluate(() => window.__freeRoam?.getWorld()?.players?.length || 0)).toBe(2);''',
)
append_once(
    "tests/free-roam.e2e.spec.mjs",
    'test("a stale listed room is explained instead of contradicting the lobby"',
    '''test("a stale listed room is explained instead of contradicting the lobby", async ({browser}, testInfo) => {
  const mobile = testInfo.project.name.includes("webkit");
  const options = mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}};
  const hostContext = await browser.newContext(options);
  const crewContext = await browser.newContext(options);
  const newcomerContext = await browser.newContext(options);
  await prepareContext(hostContext);
  await prepareContext(crewContext);
  await prepareContext(newcomerContext);
  const host = await hostContext.newPage();
  const crew = await crewContext.newPage();
  const newcomer = await newcomerContext.newPage();
  try {
    await Promise.all([
      host.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
      crew.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
      newcomer.goto("/free-roam.html", {waitUntil: "domcontentloaded"}),
    ]);
    await host.getByRole("button", {name: "Создать свободный мир"}).click();
    await crew.getByRole("button", {name: "Войти в ближайший мир"}).click();
    await expect(crew.locator("#game")).toBeVisible();
    await hostContext.close();
    await newcomer.getByRole("button", {name: "Обновить"}).click();
    const staleRoom = await newcomer.evaluate(() => window.__freeRoam.preferredRoom());
    expect(staleRoom).toBeTruthy();
    await crewContext.close();
    await expect.poll(() => newcomer.evaluate(async () => {
      const response = await fetch("/api/rooms?mode=free", {cache: "no-store"});
      return (await response.json()).rooms?.length ?? -1;
    })).toBe(0);

    await newcomer.getByRole("button", {name: /Войти|Создать/}).click();
    await expect(newcomer.locator("#game")).toBeVisible();
    await expect(newcomer.locator("#message")).toContainText("закрылся до подключения");
    await expect.poll(() => newcomer.evaluate(() => window.__freeRoam.isHost())).toBe(true);
    expect(await newcomer.evaluate(() => window.__freeRoam.roomId())).not.toBe(staleRoom);
  } finally {
    await newcomerContext.close();
  }
});

test("tow and landing sounds fade with listener distance", async ({browser}, testInfo) => {
  const mobile = testInfo.project.name.includes("webkit");
  const context = await browser.newContext(mobile
    ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true}
    : {viewport: {width: 1280, height: 900}});
  await prepareContext(context);
  const page = await context.newPage();
  try {
    await page.goto("/free-roam.html", {waitUntil: "domcontentloaded"});
    await page.getByRole("button", {name: "Создать свободный мир"}).click();
    await expect(page.locator("#game")).toBeVisible();
    await page.evaluate(() => {
      const world = window.__freeRoam.getWorld();
      Object.assign(world.players[0], {x: 210, y: 158, heading: 0});
      window.__freeRoam.setWorld(world);
      window.__freeRoam.handleEvent({type: "tow-creak", targets: [0, 1], tension: 0.9, x: 210, y: 158});
    });
    const near = await page.evaluate(() => window.__freeRoam.audioDiagnostics().towGain);
    await page.evaluate(() => {
      const world = window.__freeRoam.getWorld();
      Object.assign(world.players[0], {mode: "foot", activeBoat: null, x: 120, y: 10, heading: 0});
      window.__freeRoam.setWorld(world);
      window.__freeRoam.handleEvent({type: "tow-creak", targets: [0, 1], tension: 0.9, x: 300, y: 300});
    });
    const far = await page.evaluate(() => window.__freeRoam.audioDiagnostics().towGain);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeLessThan(near * 0.25);
  } finally {
    await context.close();
  }
});''',
)

print("free-roam polish patch applied")
