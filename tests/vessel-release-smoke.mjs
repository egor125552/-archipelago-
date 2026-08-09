import {vesselRegistry, attachVesselArchitecture, nativeVesselForBoat} from "../public/src/vessel/vessel-runtime.js";
import {migratePersistedVesselWorld} from "../public/src/vessel/vessel-save.js";

const types = vesselRegistry().listVesselTypes().map(type => type.id).sort();
if (types.join(",") !== "dual-turret-patrol,medium-crew-vessel,standard") throw new Error(`unexpected production vessel types: ${types.join(",")}`);
console.log("vessel registry loaded");

const saved = {boats: [{id: 0, boatType: "standard", hull: 88}], players: []};
const migrated = migratePersistedVesselWorld(saved);
if (!migrated.boats[0].vesselInstanceId || saved.boats[0].vesselInstanceId) throw new Error("transactional save migration failed");
console.log("vessel save migration loaded");

const world = {boats: [{id: 0, boatType: "standard", hull: 88}], players: []};
attachVesselArchitecture(world);
const entry = nativeVesselForBoat(world, 0);
if (!entry || entry.instance.typeId !== "standard") throw new Error("native vessel adoption failed");
console.log("vessel runtime adoption loaded");
