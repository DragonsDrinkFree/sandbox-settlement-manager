import { MODULE_ID, SETTINGS } from "../../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class MenuItemEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _item;

  constructor(item, options = {}) {
    super(options);
    this._item = foundry.utils.deepClone(item);
  }

  get title() {
    return game.i18n.localize(
      this._item?.name
        ? "SANDBOX_SETTLEMENT_MANAGER.inn.menuItem.editTitle"
        : "SANDBOX_SETTLEMENT_MANAGER.inn.menuItem.addTitle"
    );
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-menu-item-edit`,
    tag: "form",
    form: { handler: MenuItemEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 400 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/inn/menu-item-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(item = {}) {
    return new Promise(resolve => {
      const existing = foundry.applications.instances.get(`${MODULE_ID}-menu-item-edit`);
      if (existing) existing.close();
      const app = new MenuItemEditApp(item);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const defaultCurrencyId = (currencies.find(c => c.isStandard) ?? currencies[0])?.id ?? "";
    const hasPriceOverride = !!this._item.price;
    return {
      item: {
        name:        this._item.name        ?? "",
        description: this._item.description ?? "",
        price: {
          currencyId: this._item.price?.currencyId ?? defaultCurrencyId,
          amount:     this._item.price?.amount     ?? 0
        }
      },
      hasPriceOverride,
      currencies,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();

    const priceCheckbox = this.element.querySelector('[name="hasPriceOverride"]');
    const priceFields   = this.element.querySelector(".price-override-fields");
    const togglePrice   = () => { if (priceFields) priceFields.hidden = !priceCheckbox?.checked; };
    togglePrice();
    priceCheckbox?.addEventListener("change", togglePrice);
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;
    const description    = (formData.object.description ?? "").trim();
    const hasPriceOverride = !!formData.object.hasPriceOverride;
    const price = hasPriceOverride ? {
      currencyId: formData.object.priceCurrencyId ?? "",
      amount:     parseFloat(formData.object.priceAmount) || 0
    } : null;
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id:          this._item.id || foundry.utils.randomID(),
      name,
      description,
      price
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
