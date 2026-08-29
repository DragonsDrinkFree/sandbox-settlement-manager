import { MODULE_ID, SETTINGS } from "../constants.js";
import { ItemTypeEditApp } from "./item-type-edit-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ItemConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _itemTypes = null;   // null = uninitialized; populated on first _prepareContext
  _globalFields = null; // cached DOM values preserved across item-type re-renders

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-item-config`,
    tag: "form",
    form: { handler: ItemConfigApp.#onSubmit, closeOnSubmit: true },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.name" },
    position: { width: 540 },
    actions: {
      addItemType:    ItemConfigApp.#onAddItemType,
      editItemType:   ItemConfigApp.#onEditItemType,
      deleteItemType: ItemConfigApp.#onDeleteItemType
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/item-config.hbs`, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const config  = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);

    if (this._itemTypes === null) {
      this._itemTypes = foundry.utils.deepClone(config.itemTypes ?? []);
    }

    const gf = this._globalFields;
    const selectedFormat = gf?.priceFormat ?? config.priceFormat ?? "simple";
    const formats = [
      { value: "simple",              label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatSimple"),             selected: selectedFormat === "simple" },
      { value: "denomination-field",  label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatDenominationField"),  selected: selectedFormat === "denomination-field" },
      { value: "denomination-object", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatDenominationObject"), selected: selectedFormat === "denomination-object" },
      { value: "manual",              label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.setting.itemConfig.formatManual"),             selected: selectedFormat === "manual" }
    ];
    return {
      ...context,
      nameAttribute:              gf?.nameAttribute              ?? config.nameAttribute              ?? "name",
      priceFormat:                selectedFormat,
      priceAttribute:             gf?.priceAttribute             ?? config.priceAttribute             ?? "",
      priceDenominationAttribute: gf?.priceDenominationAttribute ?? config.priceDenominationAttribute ?? "",
      weightAttribute:            gf?.weightAttribute            ?? config.weightAttribute            ?? "",
      formats,
      showDenominationField: selectedFormat === "denomination-field",
      itemTypes: this._itemTypes,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const formatSelect = this.element.querySelector('[name="priceFormat"]');
    const denomRow     = this.element.querySelector('.denomination-attribute-row');
    const sync = () => { if (denomRow) denomRow.hidden = formatSelect?.value !== "denomination-field"; };
    sync();
    formatSelect?.addEventListener("change", sync);
  }

  #syncGlobalFieldsFromDOM() {
    if (!this.element) return;
    this._globalFields = {
      nameAttribute:              this.element.querySelector('[name="nameAttribute"]')?.value ?? "name",
      priceFormat:                this.element.querySelector('[name="priceFormat"]')?.value ?? "simple",
      priceAttribute:             this.element.querySelector('[name="priceAttribute"]')?.value ?? "",
      priceDenominationAttribute: this.element.querySelector('[name="priceDenominationAttribute"]')?.value ?? "",
      weightAttribute:            this.element.querySelector('[name="weightAttribute"]')?.value ?? ""
    };
  }

  /**
   * Persist the current item-type list immediately, independent of this app's own outer save.
   * Preserves nameAttribute/priceFormat/etc. exactly as currently persisted — never the DOM's
   * possibly-unsaved values for those fields, since this only commits the item-types layer.
   */
  async #persistItemTypesNow() {
    const stored = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG) ?? {};
    await game.settings.set(MODULE_ID, SETTINGS.ITEM_CONFIG, { ...stored, itemTypes: this._itemTypes });
  }

  static async #onAddItemType() {
    this.#syncGlobalFieldsFromDOM();
    const result = await ItemTypeEditApp.open({});
    if (!result) return;
    this._itemTypes.push(result);
    await this.#persistItemTypesNow();
    this.render({ parts: ["form"] });
  }

  static async #onEditItemType(event, target) {
    this.#syncGlobalFieldsFromDOM();
    const index = parseInt(target.dataset.index);
    const existing = this._itemTypes[index];
    if (!existing) return;
    const result = await ItemTypeEditApp.open(existing);
    if (!result) return;
    this._itemTypes[index] = result;
    await this.#persistItemTypesNow();
    this.render({ parts: ["form"] });
  }

  static async #onDeleteItemType(event, target) {
    this.#syncGlobalFieldsFromDOM();
    const index = parseInt(target.dataset.index);
    this._itemTypes.splice(index, 1);
    await this.#persistItemTypesNow();
    this.render({ parts: ["form"] });
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    await game.settings.set(MODULE_ID, SETTINGS.ITEM_CONFIG, {
      nameAttribute:              (data.nameAttribute              ?? "name").trim() || "name",
      priceFormat:                data.priceFormat                 ?? "simple",
      priceAttribute:             (data.priceAttribute             ?? "").trim(),
      priceDenominationAttribute: (data.priceDenominationAttribute ?? "").trim(),
      weightAttribute:            (data.weightAttribute            ?? "").trim(),
      itemTypes:                  this._itemTypes ?? []
    });
  }
}
