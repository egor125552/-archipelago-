import test from "node:test";
import assert from "node:assert/strict";
import {access, readFile} from "node:fs/promises";

async function missing(path) {
  try {
    await access(new URL(path, import.meta.url));
    return false;
  } catch (_) {
    return true;
  }
}

test("temporary client action layers are gone", async () => {
  assert.equal(await missing("../public/src/free-roam-local-actions.js"), true);
  assert.equal(await missing("../public/src/free-roam-sharp-action-cues-v1.js"), true);
  assert.equal(await missing("../public/src/free-roam-sharp-feedback-v1.js"), true);
});

test("durable persistence is singular while live reload remains independent", async () => {
  const [client, startup, worker] = await Promise.all([
    readFile(new URL("../public/src/free-roam-saved-world-v1.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-startup-v1.js", import.meta.url), "utf8"),
    readFile(new URL("../src/worker-persistent.js", import.meta.url), "utf8"),
  ]);
  assert.match(client, /resumeSavedButton/);
  assert.match(client, /join\.textContent = "Войти в ближайший мир"/);
  assert.doesNotMatch(client, /sessionStorage\.removeItem/);
  assert.match(startup, /sessionStorage\.setItem\(SESSION_KEY/);
  assert.match(worker, /PRIMARY_ROOM_STORAGE_KEY/);
  assert.doesNotMatch(worker, /routeToPrimaryRoom/);
  assert.match(worker, /claimPrimarySavedRoom/);
});
