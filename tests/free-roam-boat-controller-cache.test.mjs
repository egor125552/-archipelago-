import test from "node:test";
import assert from "node:assert/strict";
import {access, readFile, stat} from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("Safari entry points resolve the rebuilt controller modules", async () => {
  const html = await readFile(new URL("../public/free-roam.html", import.meta.url), "utf8");
  assert.match(html, /free-roam-core-v8\.js\?v=2[^\n]+free-roam-core-v8\.js\?v=4/);
  assert.match(html, /free-roam-replication-v2\.js\?v=1[^\n]+free-roam-replication-v2\.js\?v=2/);
  assert.match(html, /free-roam-dual-turret-client\.js\?v=5/);
  assert.match(html, /free-roam-v4\.js\?v=62/);
});

test("the patrol engine asset exists and the client suppresses the standard motor", async () => {
  const asset = new URL("../public/assets/audio/free-roam-dual-turret/dual-turret-engine-v1.mp3", import.meta.url);
  const information = await stat(asset);
  assert.ok(information.size > 1000);
  const [audio, client] = await Promise.all([
    readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-client.js", import.meta.url), "utf8"),
  ]);
  assert.match(audio, /dual-turret-engine-v1\.mp3\?v=2/);
  assert.match(audio, /source\.loop = true/);
  assert.match(client, /customBoat\.engineStalled = true/);
  assert.match(client, /updateDualTurretEngine\(this, world, playerIndex\)/);
});

test("obsolete parallel patrol runtimes are gone", async () => {
  await assert.rejects(access(new URL("../public/src/free-roam-player-boats.js", import.meta.url)));
  await assert.rejects(access(new URL("../public/src/free-roam-dual-turret-test-lifecycle.js", import.meta.url)));
  await assert.rejects(access(new URL("../public/src/free-roam-dual-turret-purchase.js", import.meta.url)));
  assert.ok(root);
});
