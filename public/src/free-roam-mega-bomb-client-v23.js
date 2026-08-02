"use strict";

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  const megaBombAudio = url.includes("/audio/mega-bomb-");
  if (url.includes("mega-bomb-explosion-v11.mp3")) {
    return Promise.reject(new Error("Старый запасной звук мегабомбы отключён"));
  }
  const response = await originalFetch(
    input,
    megaBombAudio ? {...init, cache: "reload"} : init,
  );
  if (megaBombAudio) {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html")) {
      throw new Error(`Вместо аудиофайла сервер вернул HTML: ${url}`);
    }
  }
  return response;
};

await import("./free-roam-mega-bomb-client-v22.js?v=3");
