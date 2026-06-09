import { MODULE_ID, SETTINGS } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/** Exportable configuration sections (checkbox key → world setting). */
export const SECTIONS = [
  { key: "settlementTypes", setting: SETTINGS.SETTLEMENT_TYPES, labelKey: "SANDBOX_SETTLEMENT_MANAGER.importExport.sectionSettlementTypes" },
  { key: "currencyConfig",  setting: SETTINGS.CURRENCY_CONFIG,  labelKey: "SANDBOX_SETTLEMENT_MANAGER.importExport.sectionCurrency" },
  { key: "itemConfig",      setting: SETTINGS.ITEM_CONFIG,      labelKey: "SANDBOX_SETTLEMENT_MANAGER.importExport.sectionItem" },
  { key: "locationTypes",   setting: SETTINGS.LOCATION_TYPES,   labelKey: "SANDBOX_SETTLEMENT_MANAGER.importExport.sectionLocationTemplates" }
];

const EXPORT_FORMAT_VERSION = 1;

export class ImportExportApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-import-export`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.importExport.title" },
    position: { width: 460 },
    actions: {
      exportConfig: ImportExportApp.#onExport,
      importConfig: ImportExportApp.#onImport
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/settings/import-export.hbs` }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      sections: SECTIONS.map(s => ({ key: s.key, label: game.i18n.localize(s.labelKey) }))
    };
  }

  /** Keys of the currently-checked section checkboxes. */
  #getCheckedKeys() {
    return SECTIONS
      .filter(s => this.element.querySelector(`[name="section-${s.key}"]`)?.checked)
      .map(s => s.key);
  }

  static #onExport() {
    const checked = this.#getCheckedKeys();
    if (!checked.length) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.nothingSelected"));
      return;
    }
    const data = {};
    for (const s of SECTIONS) {
      if (checked.includes(s.key)) data[s.key] = game.settings.get(MODULE_ID, s.setting);
    }
    const payload = { module: MODULE_ID, version: EXPORT_FORMAT_VERSION, exportedAt: new Date().toISOString(), data };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    foundry.utils.saveDataToFile(JSON.stringify(payload, null, 2), "application/json", `ssm-config-${stamp}.json`);
  }

  static async #onImport() {
    const file = this.element.querySelector('[name="importFile"]')?.files?.[0];
    if (!file) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.noFile"));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await foundry.utils.readTextFromFile(file));
    } catch (err) {
      ui.notifications.error(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.invalidFile"));
      return;
    }

    const fileData = (payload && typeof payload === "object" && payload.data) ? payload.data : null;
    if (!fileData || typeof fileData !== "object") {
      ui.notifications.error(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.invalidFile"));
      return;
    }

    const checked  = this.#getCheckedKeys();
    const toImport = SECTIONS.filter(s => checked.includes(s.key) && s.key in fileData);
    if (!toImport.length) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.nothingToImport"));
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window:  { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.importConfirmTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.importExport.importConfirm", {
        sections: toImport.map(s => game.i18n.localize(s.labelKey)).join(", ")
      })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.importButton"), icon: "fa-solid fa-file-import" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;

    let imported = 0;
    for (const s of toImport) {
      try {
        await game.settings.set(MODULE_ID, s.setting, fileData[s.key]);
        imported++;
      } catch (err) {
        console.error(`${MODULE_ID} | Failed to import section ${s.key}`, err);
        ui.notifications.error(game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.importExport.sectionFailed", {
          section: game.i18n.localize(s.labelKey)
        }));
      }
    }
    if (imported > 0) {
      ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.importComplete"));
      this.close();
    }
  }
}
