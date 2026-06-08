import { MODULE_ID, SETTINGS } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class MerchantItemEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _item;

  constructor(item, options = {}) {
    super(options);
    this._item = foundry.utils.deepClone(item);
  }

  get title() {
    return game.i18n.localize(
      this._item?.name
        ? "SANDBOX_SETTLEMENT_MANAGER.merchant.item.editTitle"
        : "SANDBOX_SETTLEMENT_MANAGER.merchant.item.addTitle"
    );
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-merchant-item-edit`,
    tag: "form",
    form: { handler: MerchantItemEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 400 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/merchant-item-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(item = {}) {
    return new Promise(resolve => {
      const existing = foundry.applications.instances.get(`${MODULE_ID}-merchant-item-edit`);
      if (existing) existing.close();
      const app = new MerchantItemEditApp(item);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];
    const defaultCurrencyId = currencies[0]?.id ?? "";

    const itemConfig  = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);
    const typeOptions = (itemConfig.itemTypes ?? []).map(t => ({
      value:    t.systemType,
      label:    t.label,
      selected: (this._item.itemType ?? "") === t.systemType
    }));

    const settlementTypes = game.settings.get(MODULE_ID, SETTINGS.SETTLEMENT_TYPES) ?? [];

    return {
      item: {
        name:              this._item.name              ?? "",
        itemType:          this._item.itemType          ?? "",
        minSettlementSize:       this._item.minSettlementSize       ?? "",
        stockAvailability: this._item.stockAvailability ?? 100,
        stockFormula:      this._item.stockFormula      ?? "",
        price: {
          currencyId: this._item.price?.currencyId ?? defaultCurrencyId,
          amount:     this._item.price?.amount     ?? 0
        }
      },
      currencies,
      typeOptions,
      settlementTypes,
      hasTypes:     typeOptions.length > 0,
      hasSettlementTypes: settlementTypes.length > 0,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;
    const price = {
      currencyId: formData.object.priceCurrencyId ?? "",
      amount:     parseFloat(formData.object.priceAmount) || 0
    };
    const itemType         = (formData.object.itemType    ?? "").trim() || null;
    const minSettlementSize      = (formData.object.minSettlementSize ?? "").trim();
    const stockAvailability = parseFloat(formData.object.stockAvailability) || 100;
    const stockFormula     = (formData.object.stockFormula ?? "").trim();
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id:               this._item.id || foundry.utils.randomID(),
      name,
      price,
      itemId:           this._item.itemId        ?? null,
      quantity:         this._item.quantity      ?? null,
      itemType,
      minSettlementSize,
      stockAvailability,
      stockFormula,
      templateItemId:   this._item.templateItemId  ?? null,
      _templateValues:  this._item._templateValues ?? null
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
