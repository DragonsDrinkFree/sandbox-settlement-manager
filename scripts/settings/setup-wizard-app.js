import { MODULE_ID, SETTINGS } from "../constants.js";
import { SECTIONS } from "./import-export-app.js";
import { CurrencyConfigApp } from "./currency-config.js";
import { SettlementTypeConfigApp } from "./settlement-type-config.js";
import { ItemConfigApp } from "./item-config.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

const STEP_COUNT = 5;

export class SetupWizardApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _step = 0;
  _presets = [];
  _presetApplied = false;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-setup-wizard`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.wizard.title" },
    position: { width: 520 },
    actions: {
      back:                     SetupWizardApp.#onBack,
      next:                     SetupWizardApp.#onNext,
      finish:                   SetupWizardApp.#onFinish,
      applyPreset:              SetupWizardApp.#applyPreset,
      continueCustomizing:      SetupWizardApp.#continueCustomizing,
      jumpToFinish:             SetupWizardApp.#jumpToFinish,
      openCurrencyConfig:       SetupWizardApp.#openCurrencyConfig,
      openSettlementTypeConfig: SetupWizardApp.#openSettlementTypeConfig,
      openItemConfig:           SetupWizardApp.#openItemConfig,
      openGameSettings:         SetupWizardApp.#openGameSettings
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/settings/setup-wizard.hbs` }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const step = this._step;

    if (!this._presets.length) {
      try {
        const res = await fetch(`modules/${MODULE_ID}/presets/index.json`);
        this._presets = await res.json();
      } catch (e) {
        this._presets = [];
      }
    }

    const currencyConfig  = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const settlementTypes = game.settings.get(MODULE_ID, SETTINGS.SETTLEMENT_TYPES);
    const itemConfig      = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);

    const priceFormatLabels = {
      simple:                game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatSimple"),
      "denomination-field":  game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatDenominationField"),
      "denomination-object": game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatDenominationObject"),
      manual:                game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatManual")
    };

    const mode = currencyConfig.mode ?? "loose";
    const currencyModeLabel = game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.currency.mode.${mode}`);

    return {
      ...context,
      step,
      step0: step === 0,
      step1: step === 1,
      step2: step === 2,
      step3: step === 3,
      step4: step === 4,
      isFirstStep: step === 0,
      isLastStep:  step === STEP_COUNT - 1,
      step0done: step > 0,
      step1done: step > 1,
      step2done: step > 2,
      step3done: step > 3,
      presets:          this._presets,
      presetApplied:    this._presetApplied,
      currencies:       currencyConfig.currencies ?? [],
      currencyModeLabel,
      settlementTypes,
      priceFormat:      priceFormatLabels[itemConfig.priceFormat] ?? itemConfig.priceFormat,
      itemTypeCount:    (itemConfig.itemTypes ?? []).length
    };
  }

  async close(options = {}) {
    if (options._wizard_close || game.settings.get(MODULE_ID, SETTINGS.WIZARD_SHOWN)) {
      return super.close(options);
    }
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window:  { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.wizard.closeTitle") },
      content: `<p>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.wizard.closeNotice")}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.wizard.closeConfirm"), icon: "fa-solid fa-xmark" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.wizard.closeCancel"),  icon: "fa-solid fa-arrow-right" }
    });
    if (!confirmed) return;
    await game.settings.set(MODULE_ID, SETTINGS.WIZARD_SHOWN, true);
    return this.close({ _wizard_close: true });
  }

  static #onBack() { this._step = Math.max(0, this._step - 1); this.render(); }
  static #onNext() { this._step = Math.min(STEP_COUNT - 1, this._step + 1); this.render(); }

  static async #onFinish() {
    await game.settings.set(MODULE_ID, SETTINGS.WIZARD_SHOWN, true);
    this.close({ _wizard_close: true });
  }

  static async #applyPreset() {
    const selectedFile = this.element.querySelector('[name="preset"]')?.value;
    if (!selectedFile) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.presets.noneSelected"));
      return;
    }
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
    this._presetApplied = true;
    this.render();
  }

  static #continueCustomizing() { this._step = 1; this.render(); }
  static #jumpToFinish()        { this._step = STEP_COUNT - 1; this.render(); }

  static #openCurrencyConfig() {
    new CurrencyConfigApp().render(true);
    Hooks.once("closeCurrencyConfigApp", () => { if (this.element) this.render(); });
  }

  static #openSettlementTypeConfig() {
    new SettlementTypeConfigApp().render(true);
    Hooks.once("closeSettlementTypeConfigApp", () => { if (this.element) this.render(); });
  }

  static #openItemConfig() {
    new ItemConfigApp().render(true);
    Hooks.once("closeItemConfigApp", () => { if (this.element) this.render(); });
  }

  static #openGameSettings() {
    game.settings.sheet?.render(true);
    this.close({ _wizard_close: true });
  }
}
