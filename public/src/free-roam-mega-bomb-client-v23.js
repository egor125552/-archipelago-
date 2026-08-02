"use strict";

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (url.includes("mega-bomb-explosion-v11.mp3")) {
    return Promise.reject(new Error("Старый запасной звук мегабомбы отключён"));
  }
  if (url.includes("mega-bomb-explosion-v12.mp3")) {
    return originalFetch(input, {...init, cache: "reload"});
  }
  return originalFetch(input, init);
};

await import("./free-roam-mega-bomb-client-v22.js?v=2");
