// Import from here — never from main.js — to avoid circular ES module dependency issues.
// See reference: ApplicationV2-overlay-pattern.md

export const MODULE_ID = "sandbox-settlement-manager";
export const MODULE_TITLE = "Sandbox Settlement Manager";

/** Flag keys stored on Documents. Usage: document.setFlag(MODULE_ID, FLAGS.KEY, value) */
export const FLAGS = {
  IS_SETTLEMENT: "isSettlement",
  SETTLEMENT_NAME: "settlementName",
  SETTLEMENT_TYPE: "settlementType",
  LOCATIONS: "locations",
  GLOBAL_DEPOSITS: "globalDeposits",
  LEDGER: "ledger"
};

/** Setting keys registered via game.settings.register. Usage: game.settings.get(MODULE_ID, SETTINGS.KEY) */
export const SETTINGS = {
  SETTLEMENT_TYPES:    "settlementTypes",
  LOCATION_TYPES: "locationTypes",
  CURRENCY_CONFIG: "currencyConfig",
  HOURS_PER_DAY: "hoursPerDay",
  DAYS_PER_WEEK:  "daysPerWeek",
  ITEM_CONFIG:    "itemConfig",
  GLOBAL_DEPOSITS: "globalDeposits",
  WIZARD_SHOWN:   "wizardShown"
};

export const LOCATION_TYPE_IDS = {
  INN:           "inn",
  MERCHANT:      "merchant",
  BANK:          "bank"
};

/**
 * Migration helper — reads typeEntries from any location regardless of storage generation.
 * Returns [{ typeId, subTypeId }]. The returned entries may lack an `id` field on old data;
 * call migrateLocation() to normalise before use.
 */
export function getTypeEntries(location) {
  if (location.typeEntries) return location.typeEntries;
  if (location.typeIds) return location.typeIds.map(id => ({ typeId: id, subTypeId: null }));
  if (location.typeId) return [{ typeId: location.typeId, subTypeId: location.subTypeId ?? null }];
  return [];
}

/**
 * One-time data-model migration. Mutates `location` in place and returns it.
 * Safe to call repeatedly — already-migrated locations are left unchanged.
 *
 * What it does:
 *   1. Ensures every typeEntry has a stable `id` field.
 *   2. Moves legacy flat typeData keys ("inn", "merchant", "bank") to typeData[entry.id]
 *      for the first entry of each type that doesn't yet have keyed data.
 */
export function migrateLocation(location) {
  const entries = getTypeEntries(location);

  // Step 1 — add ids to entries that lack them
  const seenTypes = {};
  for (const entry of entries) {
    if (!entry.id) entry.id = foundry.utils.randomID();
    seenTypes[entry.typeId] ??= entry.id;
  }
  location.typeEntries = entries;

  // Step 2 — lift flat typeData keys up to entryId-keyed form
  const typeData = location.typeData ?? {};
  for (const [typeId, firstEntryId] of Object.entries(seenTypes)) {
    if (typeData[typeId] !== undefined && typeData[firstEntryId] === undefined) {
      typeData[firstEntryId] = typeData[typeId];
      delete typeData[typeId];
    }
  }
  location.typeData = typeData;

  // Step 2b — backfill the loans array on bank entries created before the Loans feature.
  for (const entry of entries) {
    if (entry.typeId === "bank" && typeData[entry.id] && typeData[entry.id].loans === undefined) {
      typeData[entry.id].loans = [];
    }
  }

  // Step 3 — lift purchasingOverrides from first merchant entry up to location level
  if (!location.purchasingOverrides) {
    const firstMerchantId = seenTypes["merchant"];
    const merchantData = firstMerchantId ? typeData[firstMerchantId] : null;
    if (merchantData?.purchasingOverrides) {
      location.purchasingOverrides = merchantData.purchasingOverrides;
      delete merchantData.purchasingOverrides;
    }
  }

  return location;
}

/** Hardcoded core location types. Sub-types are configured in SETTINGS.LOCATION_TYPES. */
export const CORE_LOCATION_TYPES = [
  { id: "inn",           name: "Inn",           icon: "fa-solid fa-bed" },
  { id: "merchant",      name: "Merchant",      icon: "fa-solid fa-store" },
  { id: "bank",          name: "Bank",          icon: "fa-solid fa-coins" }
];
