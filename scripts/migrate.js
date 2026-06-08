// One-time data migrations. Runs GM-only on the "ready" hook, guarded by a stored
// schema version so each step executes exactly once across all worlds.
//
// v1 — "city" → "settlement" and "resource" → "location" re-theme:
//   scene flags  isCity/cityName/cityType/resources → isSettlement/settlementName/settlementType/locations
//   world settings  cityTypes → settlementTypes,  resourceTypes → locationTypes
//   drops the removed `currency_test` location type from both scenes and settings.

import { MODULE_ID, FLAGS, SETTINGS, SCHEMA_VERSION, getTypeEntries } from "./constants.js";

export async function runMigrations() {
  if (!game.user.isGM) return;
  const current = Number(game.settings.get(MODULE_ID, SETTINGS.SCHEMA_VERSION)) || 0;
  if (current >= SCHEMA_VERSION) return;

  try {
    if (current < 1) await migrateToV1();
    await game.settings.set(MODULE_ID, SETTINGS.SCHEMA_VERSION, SCHEMA_VERSION);
    console.log(`${MODULE_ID} | Migrated persisted data to schema v${SCHEMA_VERSION}`);
  } catch (err) {
    console.error(`${MODULE_ID} | Migration failed; schema version left unchanged`, err);
  }
}

/** Strip the removed currency_test type from a location record. Returns null if nothing remains. */
function cleanLocation(record) {
  const cloned = foundry.utils.deepClone(record);
  const entries = getTypeEntries(cloned).filter(e => e.typeId !== "currency_test");
  if (entries.length === 0) return null;
  cloned.typeEntries = entries;
  // Remove legacy single/array type fields now that typeEntries is authoritative.
  delete cloned.typeId;
  delete cloned.typeIds;
  delete cloned.subTypeId;
  if (cloned.typeData) {
    delete cloned.typeData.currency_test;
    delete cloned.typeData.expenses;
  }
  return cloned;
}

async function migrateToV1() {
  // --- Scene flags ------------------------------------------------------------
  for (const scene of game.scenes) {
    const ns = scene.flags?.[MODULE_ID];
    if (!ns) continue;

    if ("isCity" in ns) {
      await scene.setFlag(MODULE_ID, FLAGS.IS_SETTLEMENT, ns.isCity);
      await scene.unsetFlag(MODULE_ID, "isCity");
    }
    if ("cityName" in ns) {
      await scene.setFlag(MODULE_ID, FLAGS.SETTLEMENT_NAME, ns.cityName);
      await scene.unsetFlag(MODULE_ID, "cityName");
    }
    if ("cityType" in ns) {
      await scene.setFlag(MODULE_ID, FLAGS.SETTLEMENT_TYPE, ns.cityType);
      await scene.unsetFlag(MODULE_ID, "cityType");
    }
    if ("resources" in ns) {
      const locations = (Array.isArray(ns.resources) ? ns.resources : [])
        .map(cleanLocation)
        .filter(Boolean);
      await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
      await scene.unsetFlag(MODULE_ID, "resources");
    }
  }

  // --- World settings ---------------------------------------------------------
  // Old keys are no longer registered, so read their raw Setting documents directly.
  const worldSettings = game.settings.storage.get("world");
  const readRaw = (key) => {
    const fullKey = `${MODULE_ID}.${key}`;
    const doc = worldSettings?.getSetting?.(fullKey)
      ?? worldSettings?.find?.(s => s.key === fullKey);
    if (!doc) return undefined;
    try { return JSON.parse(doc.value); } catch { return doc.value; }
  };

  const oldSettlementTypes = readRaw("cityTypes");
  if (oldSettlementTypes !== undefined) {
    await game.settings.set(MODULE_ID, SETTINGS.SETTLEMENT_TYPES, oldSettlementTypes);
  }

  const oldLocationTypes = readRaw("resourceTypes");
  if (oldLocationTypes !== undefined) {
    if (oldLocationTypes && typeof oldLocationTypes === "object") delete oldLocationTypes.currency_test;
    await game.settings.set(MODULE_ID, SETTINGS.LOCATION_TYPES, oldLocationTypes);
  }
}
