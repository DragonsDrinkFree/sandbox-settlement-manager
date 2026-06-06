import { MODULE_ID, SETTINGS } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ItemConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-item-config`,
    tag: "form",
    form: { handler: ItemConfigApp.#onSubmit, closeOnSubmit: true },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.name" },
    position: { width: 480 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/item-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const config = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);
    const selectedFormat = config.priceFormat ?? "simple";
    const formats = [
      { value: "simple",              label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatSimple"),             selected: selectedFormat === "simple" },
      { value: "denomination-field",  label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatDenominationField"),  selected: selectedFormat === "denomination-field" },
      { value: "denomination-object", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatDenominationObject"), selected: selectedFormat === "denomination-object" },
      { value: "manual",              label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatManual"),             selected: selectedFormat === "manual" }
    ];
    return {
      ...context,
      nameAttribute:              config.nameAttribute              ?? "name",
      priceFormat:                selectedFormat,
      priceAttribute:             config.priceAttribute             ?? "",
      priceDenominationAttribute: config.priceDenominationAttribute ?? "",
      formats,
      showDenominationField: selectedFormat === "denomination-field",
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const formatSelect = this.element.querySelector('[name="priceFormat"]');
    const denomRow = this.element.querySelector('.denomination-attribute-row');
    const sync = () => { if (denomRow) denomRow.hidden = formatSelect?.value !== "denomination-field"; };
    sync();
    formatSelect?.addEventListener("change", sync);
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    await game.settings.set(MODULE_ID, SETTINGS.ITEM_CONFIG, {
      nameAttribute:              (data.nameAttribute              ?? "name").trim() || "name",
      priceFormat:                data.priceFormat                 ?? "simple",
      priceAttribute:             (data.priceAttribute             ?? "").trim(),
      priceDenominationAttribute: (data.priceDenominationAttribute ?? "").trim()
    });
  }
}
