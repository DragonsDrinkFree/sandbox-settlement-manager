import { MODULE_ID, SETTINGS } from "../../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class LodgingEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _lodging;

  constructor(lodging, options = {}) {
    super(options);
    this._lodging = lodging;
  }

  get title() {
    return game.i18n.localize(
      this._lodging?.name
        ? "SANDBOX_SETTLEMENT_MANAGER.inn.lodging.editTitle"
        : "SANDBOX_SETTLEMENT_MANAGER.inn.lodging.addTitle"
    );
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-lodging-edit`,
    tag: "form",
    form: { handler: LodgingEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 380 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/inn/lodging-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(lodging = {}) {
    return new Promise(resolve => {
      const app = new LodgingEditApp(foundry.utils.deepClone(lodging));
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const defaultCurrencyId = currencies[0]?.id ?? "";
    const autoWeekly = !this._lodging.pricePerWeek;
    return {
      lodging: {
        name:       this._lodging.name       ?? "",
        beds:       this._lodging.beds       ?? 1,
        infinite:   this._lodging.infinite   ?? true,
        pricePerDay: {
          currencyId: this._lodging.pricePerDay?.currencyId ?? defaultCurrencyId,
          amount:     this._lodging.pricePerDay?.amount     ?? 0
        },
        pricePerWeek: this._lodging.pricePerWeek ?? { currencyId: defaultCurrencyId, amount: 0 }
      },
      currencies,
      autoWeekly,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
    const autoCheckbox = this.element.querySelector('[name="autoWeekly"]');
    const weeklyFields = this.element.querySelector('.price-per-week-fields');
    const toggleWeekly = () => {
      if (weeklyFields) weeklyFields.hidden = !!autoCheckbox?.checked;
    };
    toggleWeekly();
    autoCheckbox?.addEventListener("change", toggleWeekly);
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;
    const beds = Math.max(1, parseInt(formData.object.beds) || 1);
    const infinite = !!formData.object.infinite;
    const pricePerDay = {
      currencyId: formData.object.pricePerDayCurrencyId ?? "",
      amount:     parseFloat(formData.object.pricePerDayAmount) || 0
    };
    const autoWeekly = !!formData.object.autoWeekly;
    const pricePerWeek = autoWeekly ? null : {
      currencyId: formData.object.pricePerWeekCurrencyId ?? pricePerDay.currencyId,
      amount:     parseFloat(formData.object.pricePerWeekAmount) || 0
    };
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._lodging.id || foundry.utils.randomID(),
      name, beds, infinite, pricePerDay, pricePerWeek
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
