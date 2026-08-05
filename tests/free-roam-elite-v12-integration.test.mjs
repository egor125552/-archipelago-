import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("authoritative server wraps the canonical elite boss step with tactics 1.2", () => {
  const source = fs.readFileSync(new URL("../src/free-roam-server.js", import.meta.url), "utf8");
  assert.match(source, /prepareEliteBossTacticsV12\(world, chunk\)/);
  assert.match(source, /stepFreeWorld\(world, chunk\)/);
  assert.match(source, /finishEliteBossTacticsV12\(world, chunk\)/);
  assert.match(source, /launchPendingEliteBossBombs\(world\)/);
  assert.ok(source.indexOf("prepareEliteBossTacticsV12(world, chunk)") < source.indexOf("stepFreeWorld(world, chunk)"));
  assert.ok(source.indexOf("finishEliteBossTacticsV12(world, chunk)") > source.indexOf("stepFreeWorld(world, chunk)"));
});

test("live mega-bomb alias uses hostile bomb semantics v37", () => {
  const source = fs.readFileSync(new URL("../src/free-roam-mega-bomb.js", import.meta.url), "utf8");
  assert.match(source, /free-roam-mega-bomb-v37\.js\?v=1/);
});

test("developer journal compresses unchanged server ticks and repeated input packets", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-developer-log-v2.js", import.meta.url), "utf8");
  assert.match(source, /SERVER_STATE_HEARTBEAT_MS = 2000/);
  assert.match(source, /INPUT_PACKET_HEARTBEAT_MS = 2000/);
  assert.match(source, /snapshot\.eventCount > 0/);
  assert.match(source, /compressedTicks/);
  assert.match(source, /JSON\.stringify\(input\) !== JSON\.stringify\(state\.lastPacketInput\)/);
  assert.match(source, /tacticsVersion: world\.freeEliteBossTacticsV12\?\.version/);
});
