// Import from here — never from main.js — to avoid circular ES module dependency issues.
// See reference: ApplicationV2-overlay-pattern.md

export const MODULE_ID = "sandbox-settlement-manager";
export const MODULE_TITLE = "Sandbox Settlement Manager";

/** Persisted data schema version. Bump when adding a migration step in migrate.js. */
export const SCHEMA_VERSION = 1;

/** Flag keys stored on Documents. Usage: document.setFlag(MODULE_ID, FLAGS.KEY, value) */
export const FLAGS = {
  IS_SETTLEMENT: "isSettlement",
  SETTLEMENT_NAME: "settlementName",
  SETTLEMENT_TYPE: "settlementType",
  LOCATIONS: "locations",
  GLOBAL_DEPOSITS: "globalDeposits"
};

/** Setting keys registered via game.settings.register. Usage: game.settings.get(MODULE_ID, SETTINGS.KEY) */
export const SETTINGS = {
  SETTLEMENT_TYPES:    "settlementTypes",
  LOCATION_TYPES: "locationTypes",
  CURRENCY_CONFIG: "currencyConfig",
  HOURS_PER_DAY: "hoursPerDay",
  DAYS_PER_WEEK:  "daysPerWeek",
  ITEM_CONFIG:    "itemConfig",
  SCHEMA_VERSION: "schemaVersion"
};

export const LOCATION_TYPE_IDS = {
  INN:           "inn",
  MERCHANT:      "merchant",
  BANK:          "bank"
};

/**
 * Migration helper — reads typeEntries from any location regardless of storage generation.
 * Returns [{ typeId, subTypeId }]. Remove once all persisted data uses typeEntries format.
 */
export function getTypeEntries(location) {
  if (location.typeEntries) return location.typeEntries;
  if (location.typeIds) return location.typeIds.map(id => ({ typeId: id, subTypeId: null }));
  if (location.typeId) return [{ typeId: location.typeId, subTypeId: location.subTypeId ?? null }];
  return [];
}

/** Hardcoded core location types. Sub-types are configured in SETTINGS.LOCATION_TYPES. */
export const CORE_LOCATION_TYPES = [
  { id: "inn",           name: "Inn",           icon: "fa-solid fa-bed" },
  { id: "merchant",      name: "Merchant",      icon: "fa-solid fa-store" },
  { id: "bank",          name: "Bank",          icon: "fa-solid fa-coins" }
];
