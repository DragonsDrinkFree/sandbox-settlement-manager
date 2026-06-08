import { MODULE_ID, SETTINGS } from "../../constants.js";
import { snapshot, TEMPLATE_FIELDS } from "../template-link.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class LodgingEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _lodging;
  _templateLodging;

  constructor(lodging, templateLodging, options = {}) {
    super(options);
    this._lodging         = lodging;
    this._templateLodging = templateLodging ?? null;
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

  static async open(lodging = {}, templateLodging = null) {
    return new Promise(resolve => {
      const app = new LodgingEditApp(foundry.utils.deepClone(lodging), templateLodging);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const defaultCurrencyId = currencies[0]?.id ?? "";
    const autoWeekly = !this._lodging.pricePerWeek;
    const buttons = [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }];
    if (this._templateLodging) {
      buttons.unshift({ type: "button", icon: "fa-solid fa-rotate-left", label: "Restore to Template", cssClass: "restore-template-btn" });
    }
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
      buttons
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

    this.element.querySelector('.restore-template-btn')?.addEventListener("click", () => {
      const t = this._templateLodging;
      if (!t) return;
      const resolve = this._resolve;
      this._resolve = null;
      resolve?.({
        ...foundry.utils.deepClone(t),
        id:              this._lodging.id || foundry.utils.randomID(),
        templateItemId:  this._lodging.templateItemId ?? null,
        _templateValues: snapshot(t, TEMPLATE_FIELDS.lodging)
      });
      this.close();
    });
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
      id:              this._lodging.id || foundry.utils.randomID(),
      name, beds, infinite, pricePerDay, pricePerWeek,
      templateItemId:  this._lodging.templateItemId ?? null,
      _templateValues: this._lodging._templateValues ?? null
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
