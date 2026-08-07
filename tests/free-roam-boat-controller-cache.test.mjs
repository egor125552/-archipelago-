import test from "node:test";
import assert from "node:assert/strict";
import {access, readFile, stat} from "node:fs/promises";

const root = new URL("../", import.meta.url);

function importMapFrom(html) {
  const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  return JSON.parse(match?.[1] || "{}");
}

function assertImportRedirect(imports, source, modulePath) {
  const target = imports?.[source];
  assert.equal(typeof target, "string");
  assert.match(target, new RegExp(`^${modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?v=\\d+$`));
  assert.notEqual(target, source);
}

test("Safari entry points resolve the rebuilt controller modules", async () => {
  const html = await readFile(new URL("../public/free-roam.html", import.meta.url), "utf8");
  const imports = importMapFrom(html).imports || {};
  assertImportRedirect(imports, "/src/free-roam-core-v8.js?v=2", "/src/free-roam-core-v8.js");
  assertImportRedirect(imports, "/src/free-roam-replication-v2.js?v=1", "/src/free-roam-replication-v2.js");
  assertImportRedirect(imports, "/src/free-roam-client-prediction.js?v=42", "/src/free-roam-client-prediction.js");
  assert.match(html, /free-roam-dual-turret-client\.js\?v=\d+/);
  assert.match(html, /free-roam-v4\.js\?v=\d+/);
});

test("the patrol engine asset exists and the common audio path suppresses the standard motor", async () => {
  const asset = new URL("../public/assets/audio/free-roam-dual-turret/dual-turret-engine-v1.mp3", import.meta.url);
  const information = await stat(asset);
  assert.ok(information.size > 1000);
  const [armoredAudio, commonAudio, client] = await Promise.all([
    readFile(new URL("../public/src/free-roam-dual-turret-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-audio.js", import.meta.url), "utf8"),
    readFile(new URL("../public/src/free-roam-dual-turret-client.js", import.meta.url), "utf8"),
  ]);
  assert.match(armoredAudio, /dual-turret-engine-v1\.mp3\?v=\d+/);
  assert.match(armoredAudio, /source\.loop = true/);
  assert.match(commonAudio, /customEngine = activeBoat\.audioProfile === "dual-turret"/);
  assert.match(commonAudio, /updateDualTurretEngine\(this, world, playerIndex\)/);
  assert.doesNotMatch(client, /customBoat\.engineStalled\s*=/);
  assert.doesNotMatch(client, /updateDualTurretEngine/);
  assert.match(client, /updateDualTurretUi/);
});

test("obsolete parallel patrol runtimes are gone", async () => {
  await assert.rejects(access(new URL("../public/src/free-roam-player-boats.js", import.meta.url)));
  await assert.rejects(access(new URL("../public/src/free-roam-dual-turret-test-lifecycle.js", import.meta.url)));
  await assert.rejects(access(new URL("../public/src/free-roam-dual-turret-purchase.js", import.meta.url)));
  assert.ok(root);
});
