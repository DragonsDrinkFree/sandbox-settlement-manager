import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class MerchantRestoreDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _merchantData;
  _template;
  _onSave;

  constructor(merchantData, template, onSave, options = {}) {
    super(options);
    this._merchantData = merchantData;
    this._template     = template;
    this._onSave       = onSave;
  }

  get title() {
    return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.restore.title");
  }

  static DEFAULT_OPTIONS = {
    id:   `${MODULE_ID}-merchant-restore`,
    tag:  "form",
    form: { handler: MerchantRestoreDialog.#onSubmit, closeOnSubmit: true },
    position: { width: 420 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/merchant-restore-dialog.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(merchantData, template, onSave) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-merchant-restore`);
    if (existing) existing.close();
    const app = new MerchantRestoreDialog(
      foundry.utils.deepClone(merchantData),
      template,
      onSave
    );
    app.render(true);
    return app;
  }

  async _prepareContext(options) {
    const templateItems = this._template?.typeData?.merchant?.inventory ?? [];
    const resourceItems = this._merchantData.inventory ?? [];

    const changedItems = resourceItems.filter(item => {
      if (!item.templateItemId || !item._templateValues) return false;
      const tv = item._templateValues;
      return (
        item.name              !== tv.name              ||
        item.itemId            !== tv.itemId            ||
        item.minCitySize       !== tv.minCitySize       ||
        item.stockAvailability !== tv.stockAvailability ||
        item.stockFormula      !== tv.stockFormula      ||
        item.price?.amount     !== tv.price?.amount     ||
        item.price?.currencyId !== tv.price?.currencyId
      );
    });

    const missingItems = templateItems.filter(
      ti => !resourceItems.some(ri => ri.templateItemId === ti.id)
    );

    const hasAnyItems = !!(changedItems.length || missingItems.length);

    return {
      changedItems,
      missingItems,
      hasAnyItems,
      buttons: [{ type: "submit", icon: "fa-solid fa-rotate-left", label: "Restore Selected" }]
    };
  }

  static async #onSubmit(event, form) {
    const merchantData  = foundry.utils.deepClone(this._merchantData);
    const templateItems = this._template?.typeData?.merchant?.inventory ?? [];
    const checked       = [...form.querySelectorAll('input[type="checkbox"][data-restore-id]:checked')];

    for (const cb of checked) {
      const kind = cb.dataset.restoreKind;
      const id   = cb.dataset.restoreId;

      if (kind === "changed") {
        const item = merchantData.inventory?.find(x => x.id === id);
        if (!item?._templateValues) continue;
        const tv = item._templateValues;
        Object.assign(item, {
          name:              tv.name,
          itemId:            tv.itemId,
          minCitySize:       tv.minCitySize,
          stockAvailability: tv.stockAvailability,
          stockFormula:      tv.stockFormula,
          price:             foundry.utils.deepClone(tv.price)
        });
      } else {
        const ti = templateItems.find(x => x.id === id);
        if (!ti) continue;
        merchantData.inventory ??= [];
        merchantData.inventory.push({
          ...foundry.utils.deepClone(ti),
          id:             foundry.utils.randomID(),
          templateItemId: ti.id,
          quantity:       null,
          _templateValues: {
            name:              ti.name,
            itemId:            ti.itemId            ?? null,
            minCitySize:       ti.minCitySize       ?? "",
            stockAvailability: ti.stockAvailability ?? 100,
            stockFormula:      ti.stockFormula      ?? "",
            price:             { ...(ti.price ?? {}) }
          }
        });
      }
    }

    await this._onSave(merchantData);
  }
}
