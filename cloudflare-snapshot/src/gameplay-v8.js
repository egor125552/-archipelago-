"use strict";

const byId = id => document.getElementById(id);

function command(action) {
  window.__echoArchipelago?.command?.(action);
}

byId("locationButton")?.addEventListener("click", () => command("where"));
byId("firstRescueButton")?.addEventListener("click", () => command("tutorial-first"));
