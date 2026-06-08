import { MODULE_ID, SETTINGS } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class SettlementTypeEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _settlementType;

  constructor(settlementType, options = {}) {
    super(options);
    this._settlementType = settlementType;
  }

  // Dynamic title: "Add Settlement Type" for new, "Edit Settlement Type" for existing
  get title() {
    const key = this._settlementType?.name
      ? "SANDBOX_SETTLEMENT_MANAGER.settlementType.editTitle"
      : "SANDBOX_SETTLEMENT_MANAGER.settlementType.addTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-settlement-type-edit`,
    tag: "form",
    form: { handler: SettlementTypeEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 360 }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/settings/settlement-type-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /**
   * Open the dialog and return a Promise that resolves with the saved settlement type
   * object, or null if the dialog was closed without saving.
   * @param {object} [settlementType={}]  Existing settlement type data to edit, or empty for add.
   * @returns {Promise<object|null>}
   */
  static async open(settlementType = {}) {
    return new Promise(resolve => {
      const app = new SettlementTypeEditApp(foundry.utils.deepClone(settlementType));
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const currencies = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const currencyOptions = currencies.map(c => ({ id: c.id, name: c.name, abbreviation: c.abbreviation, isStandard: c.isStandard }));
    return {
      settlementType: this._settlementType,
      currencyOptions,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    // Auto-focus the name field on open
    this.element.querySelector('[name="name"]')?.focus();
  }

  static async #onSubmit(event, form, formData) {
    const name          = (formData.object.name ?? "").trim();
    const maxCurrencyId = (formData.object.maxCurrencyId ?? "").trim();
    if (!name) return; // block empty submission
    const resolve = this._resolve;
    this._resolve = null; // prevent _onClose from resolving again
    resolve?.({ ...this._settlementType, name, maxCurrencyId });
  }

  async _onClose(options) {
    await super._onClose(options);
    // Resolves with null if closed via X or Escape without saving
    this._resolve?.(null);
    this._resolve = null;
  }
}
