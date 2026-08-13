import { MODULE_ID } from "../constants.js";
import { SECTIONS } from "./import-export-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class PresetsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _presets = [];

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-presets`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.presets.title" },
    position: { width: 460 },
    actions: {
      applyPreset: PresetsApp.#onApplyPreset
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/settings/presets.hbs` }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    try {
      const res = await fetch(`modules/${MODULE_ID}/presets/index.json`);
      this._presets = await res.json();
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to load presets index`, e);
      this._presets = [];
    }
    return { ...context, presets: this._presets };
  }

  static async #onApplyPreset() {
    const selectedFile = this.element.querySelector('input[name="preset"]:checked')?.value;
    if (!selectedFile) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.presets.noneSelected"));
      return;
    }

    const preset = this._presets.find(p => p.file === selectedFile);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window:  { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.presets.confirmTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.presets.confirm", { name: preset?.name ?? selectedFile })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.presets.applyButton"), icon: "fa-solid fa-check" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;

    let data;
    try {
      const res = await fetch(`modules/${MODULE_ID}/presets/${selectedFile}`);
      const payload = await res.json();
      data = payload?.data;
    } catch (e) {
      ui.notifications.error(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.invalidFile"));
      return;
    }
    if (!data || typeof data !== "object") {
      ui.notifications.error(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.importExport.invalidFile"));
      return;
    }

    for (const s of SECTIONS) {
      if (s.key in data) {
        try { await game.settings.set(MODULE_ID, s.setting, data[s.key]); }
        catch (e) { console.error(`${MODULE_ID} | Failed to apply preset section ${s.key}`, e); }
      }
    }

    ui.notifications.info(game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.presets.applied", { name: preset?.name ?? selectedFile }));
    this.close();
  }
}
