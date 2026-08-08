import test from "node:test";
import assert from "node:assert/strict";
import {createFreeWorld, setPlayerInput, stepFreeWorld} from "../public/src/free-roam-core-v8.js";
import {nativeVesselForBoat} from "../public/src/vessel/vessel-runtime.js?v=2";
import {setVesselOccupantPosition} from "../public/src/vessel/vessel-interior.js";

test("walking input cannot accelerate or fire the armored patrol before the helm is claimed", () => {
  const world = createFreeWorld();
  const boat = world.boats.find(candidate => candidate?.boatType === "dual-turret-patrol");
  const player = world.players[0];
  boat.driver = null;
  boat.crew = [0, null];
  player.mode = "boat";
  player.activeBoat = boat.id;
  const entry = nativeVesselForBoat(world, boat.id);
  setVesselOccupantPosition(entry.definition, entry.instance, 0, {deckId: "armored-main-deck", x: 0, y: -4, heading: 0});
  const ammo = boat.turrets?.[0]?.ammo;
  setPlayerInput(world, 0, {up: true, attack: true});
  for (let index = 0; index < 4; index += 1) stepFreeWorld(world, 0.1);
  assert.equal(boat.driver, null);
  assert.equal(boat.speed, 0);
  assert.equal(boat.turrets?.[0]?.ammo, ammo);
});
