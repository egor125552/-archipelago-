import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {MERCHANT, MERCHANT_AUDIO_RANGE} from "../public/src/free-roam-shop-v4.js";
import {FREE_ROAM_SPATIAL_LOCATIONS} from "../public/src/locations/free-roam-location-registry.js";
import {spatialFallWarningThresholds} from "../public/src/spatial/spatial-free-roam-gameplay.js";

test("laboratory discovery does not overlap the merchant audio envelope", () => {
  const laboratory = FREE_ROAM_SPATIAL_LOCATIONS.find(entry => entry.definition.id === "location.spatial.lab");
  assert.ok(laboratory);
  const distance = Math.hypot(
    laboratory.portal.position.x - MERCHANT.x,
    laboratory.portal.position.y - MERCHANT.y,
  );
  assert.ok(distance > laboratory.portal.discoverRadius + MERCHANT_AUDIO_RANGE,
    `laboratory/merchant guidance still overlaps at ${distance.toFixed(1)} m`);
});

test("fall warning expands before a running or airborne edge crossing", () => {
  const walking = spatialFallWarningThresholds({running:false, airborne:false});
  const running = spatialFallWarningThresholds({running:true, airborne:false});
  const airborne = spatialFallWarningThresholds({running:true, airborne:true});

  assert.deepEqual(walking, {near:4, danger:1.5, mode:"walking"});
  assert.ok(running.near > walking.near);
  assert.ok(running.danger > walking.danger);
  assert.ok(airborne.near > running.near);
  assert.ok(airborne.danger >= running.danger);
});

test("manual respawn leaves an explicit Bug Hunt marker instead of relying on 250 ms input polling", () => {
  const source = fs.readFileSync(new URL("../public/src/free-roam-manual-respawn-client.js", import.meta.url), "utf8");
  assert.match(source, /manual-respawn-request/);
  assert.match(source, /__freeRoamDeveloperLog\?\.captureServerEvents\?\./);
  assert.match(source, /clientInput: true/);
  assert.match(source, /setControl\("respawn", true\)/);
});
