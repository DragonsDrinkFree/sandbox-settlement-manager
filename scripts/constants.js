// Import from here — never from main.js — to avoid circular ES module dependency issues.
// See reference: ApplicationV2-overlay-pattern.md

export const MODULE_ID = "sandbox-settlement-manager";
export const MODULE_TITLE = "Sandbox Settlement Manager";

/** Flag keys stored on Documents. Usage: document.setFlag(MODULE_ID, FLAGS.KEY, value) */
export const FLAGS = {
  IS_CITY: "isCity",
  CITY_NAME: "cityName",
  CITY_TYPE: "cityType",
  RESOURCES: "resources"
};

/** Setting keys registered via game.settings.register. Usage: game.settings.get(MODULE_ID, SETTINGS.KEY) */
export const SETTINGS = {
  CITY_TYPES:    "cityTypes",
  RESOURCE_TYPES: "resourceTypes",
  CURRENCY_CONFIG: "currencyConfig",
  HOURS_PER_DAY: "hoursPerDay",
  DAYS_PER_WEEK:  "daysPerWeek",
  ITEM_CONFIG:    "itemConfig"
};

export const RESOURCE_TYPE_IDS = {
  INN:           "inn",
  MERCHANT:      "merchant",
  BANK:          "bank",
  CURRENCY_TEST: "currency_test"
};

/**
 * Migration helper — reads typeEntries from any resource regardless of storage generation.
 * Returns [{ typeId, subTypeId }]. Remove once all persisted data uses typeEntries format.
 */
export function getTypeEntries(resource) {
  if (resource.typeEntries) return resource.typeEntries;
  if (resource.typeIds) return resource.typeIds.map(id => ({ typeId: id, subTypeId: null }));
  if (resource.typeId) return [{ typeId: resource.typeId, subTypeId: resource.subTypeId ?? null }];
  return [];
}

/** Hardcoded core resource types. Sub-types are configured in SETTINGS.RESOURCE_TYPES. */
export const CORE_RESOURCE_TYPES = [
  { id: "inn",           name: "Inn",           icon: "fa-solid fa-bed" },
  { id: "merchant",      name: "Merchant",      icon: "fa-solid fa-store" },
  { id: "bank",          name: "Bank",          icon: "fa-solid fa-coins" },
  { id: "currency_test", name: "Currency Test", icon: "fa-solid fa-flask-vial" }
];
