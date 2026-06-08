import { MODULE_ID, SETTINGS } from "../constants.js";
import { SettlementTypeConfigApp } from "./settlement-type-config.js";
import { LocationTypeConfigApp } from "./location-type-config.js";
import { CurrencyConfigApp, DEFAULT_CURRENCIES } from "./currency-config.js";
import { ItemConfigApp } from "./item-config.js";
import { ImportExportApp } from "./import-export-app.js";

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.SETTLEMENT_TYPES, {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ArrayField(
      new foundry.data.fields.SchemaField({
        name:          new foundry.data.fields.StringField({ blank: false, trim: true }),
        maxCurrencyId: new foundry.data.fields.StringField({ initial: "" })
      })
    ),
    default: [
      { name: "Hamlet" },
      { name: "Village" },
      { name: "Small Town" },
      { name: "Large Town" },
      { name: "City" }
    ]
  });

  // Sub-types keyed by core location type id: { inn: [{id, name}], merchant: [...], ... }
  // Core types themselves are hardcoded in CORE_LOCATION_TYPES (constants.js).
  game.settings.register(MODULE_ID, SETTINGS.LOCATION_TYPES, {
    scope: "world",
    config: false,
    type: Object,
    default: { inn: [], merchant: [], bank: [] }
  });

  game.settings.register(MODULE_ID, SETTINGS.CURRENCY_CONFIG, {
    scope: "world",
    config: false,
    type: Object,
    default: { mode: "loose", currencies: DEFAULT_CURRENCIES.map(c => ({ ...c })) }
  });

  game.settings.register(MODULE_ID, SETTINGS.ITEM_CONFIG, {
    scope: "world",
    config: false,
    type: Object,
    default: { nameAttribute: "name", priceFormat: "simple", priceAttribute: "", priceDenominationAttribute: "", itemTypes: [] }
  });

  game.settings.register(MODULE_ID, SETTINGS.HOURS_PER_DAY, {
    name: "SANDBOX_SETTLEMENT_MANAGER.setting.hoursPerDay.name",
    hint: "SANDBOX_SETTLEMENT_MANAGER.setting.hoursPerDay.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 24,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTINGS.DAYS_PER_WEEK, {
    name: "SANDBOX_SETTLEMENT_MANAGER.setting.daysPerWeek.name",
    hint: "SANDBOX_SETTLEMENT_MANAGER.setting.daysPerWeek.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 7,
    restricted: true
  });

  // Config menus render (in registration order) above the plain settings above.
  // Order: Import/Export, Currency, Settlement Types, Item, Location Templates.
  game.settings.registerMenu(MODULE_ID, "importExport", {
    name: "SANDBOX_SETTLEMENT_MANAGER.setting.importExport.name",
    label: "SANDBOX_SETTLEMENT_MANAGER.setting.importExport.label",
    hint: "SANDBOX_SETTLEMENT_MANAGER.setting.importExport.hint",
    icon: "fa-solid fa-right-left",
    type: ImportExportApp,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "currencyConfig", {
    name: "SANDBOX_SETTLEMENT_MANAGER.setting.currencyConfig.name",
    label: "SANDBOX_SETTLEMENT_MANAGER.setting.currencyConfig.label",
    hint: "SANDBOX_SETTLEMENT_MANAGER.setting.currencyConfig.hint",
    icon: "fa-solid fa-coins",
    type: CurrencyConfigApp,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "settlementTypeConfig", {
    name: "SANDBOX_SETTLEMENT_MANAGER.setting.settlementTypeConfig.name",
    label: "SANDBOX_SETTLEMENT_MANAGER.setting.settlementTypeConfig.label",
    hint: "SANDBOX_SETTLEMENT_MANAGER.setting.settlementTypeConfig.hint",
    icon: "fa-solid fa-house-chimney",
    type: SettlementTypeConfigApp,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "itemConfig", {
    name: "SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.name",
    label: "SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.label",
    hint: "SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.hint",
    icon: "fa-solid fa-box",
    type: ItemConfigApp,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "locationTypeConfig", {
    name: "SANDBOX_SETTLEMENT_MANAGER.setting.locationTypeConfig.name",
    label: "SANDBOX_SETTLEMENT_MANAGER.setting.locationTypeConfig.label",
    hint: "SANDBOX_SETTLEMENT_MANAGER.setting.locationTypeConfig.hint",
    icon: "fa-solid fa-warehouse",
    type: LocationTypeConfigApp,
    restricted: true
  });
}
