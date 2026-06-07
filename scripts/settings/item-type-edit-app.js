import { MODULE_ID } from "../constants.js";
import { AttributePickerApp } from "./attribute-picker-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ItemTypeEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _itemType;
  _attributes = [];

  constructor(itemType, options = {}) {
    super(options);
    this._itemType = itemType;
  }

  get title() {
    return game.i18n.localize(
      this._itemType?.id
        ? "SANDBOX_SETTLEMENT_MANAGER.itemType.editTitle"
        : "SANDBOX_SETTLEMENT_MANAGER.itemType.addTitle"
    );
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-item-type-edit`,
    tag: "form",
    form: { handler: ItemTypeEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 560 },
    actions: {
      addAttribute:    ItemTypeEditApp.#onAddAttribute,
      browseAttribute: ItemTypeEditApp.#onBrowseAttribute,
      deleteAttribute: ItemTypeEditApp.#onDeleteAttribute
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/item-type-edit.hbs`, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(itemType = {}) {
    return new Promise(resolve => {
      const existing = foundry.applications.instances.get(`${MODULE_ID}-item-type-edit`);
      if (existing) existing.close();
      const app = new ItemTypeEditApp(foundry.utils.deepClone(itemType));
      app._attributes = foundry.utils.deepClone(itemType.attributes ?? []);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const rawTypes = game.system.documentTypes?.Item ?? [];
    const systemTypes = (Array.isArray(rawTypes) ? rawTypes : Object.keys(rawTypes))
      .filter(t => t !== "base")
      .map(t => ({
        value:    t,
        label:    CONFIG.Item?.typeLabels?.[t] ?? t,
        selected: (this._itemType.systemType ?? "") === t
      }));

    return {
      itemType:    this._itemType,
      systemTypes,
      attributes:  this._attributes,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const typeSelect = this.element.querySelector('[name="systemType"]');
    const labelInput = this.element.querySelector('[name="label"]');
    if (typeSelect && labelInput) {
      typeSelect.addEventListener("change", () => {
        if (!labelInput.value.trim()) {
          const opt = typeSelect.options[typeSelect.selectedIndex];
          labelInput.value = opt?.text ?? typeSelect.value;
        }
      });
    }
    this.element.querySelector('[name="label"]')?.focus();
  }

  #syncFormFromDOM() {
    if (!this.element) return;
    this._itemType.systemType = this.element.querySelector('[name="systemType"]')?.value ?? this._itemType.systemType;
    this._itemType.label      = this.element.querySelector('[name="label"]')?.value      ?? this._itemType.label;
  }

  #syncAttributesFromDOM() {
    const rows = this.element?.querySelectorAll(".attr-link-row") ?? [];
    this._attributes = [...rows].map(row => ({
      id:    row.dataset.attrId || foundry.utils.randomID(),
      label: (row.querySelector('[data-field="label"]')?.value ?? "").trim(),
      path:  (row.querySelector('[data-field="path"]')?.value  ?? "").trim()
    }));
  }

  static #onAddAttribute() {
    this.#syncFormFromDOM();
    this.#syncAttributesFromDOM();
    this._attributes.push({ id: foundry.utils.randomID(), label: "", path: "" });
    this.render({ parts: ["form"] });
  }

  static async #onBrowseAttribute() {
    const systemType = this.element.querySelector('[name="systemType"]')?.value;
    if (!systemType) {
      ui.notifications.warn("Select an item type first.");
      return;
    }
    this.#syncFormFromDOM();
    this.#syncAttributesFromDOM();
    const result = await AttributePickerApp.open(systemType);
    if (!result) return;
    this._attributes.push(result);
    this.render({ parts: ["form"] });
  }

  static #onDeleteAttribute(event, target) {
    this.#syncFormFromDOM();
    this.#syncAttributesFromDOM();
    const index = parseInt(target.dataset.index);
    this._attributes.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static async #onSubmit(event, form, formData) {
    const systemType = (formData.object.systemType ?? "").trim();
    if (!systemType) return;
    const label = (formData.object.label ?? "").trim() || systemType;

    const rows = form.querySelectorAll(".attr-link-row");
    const attributes = [...rows]
      .map(row => ({
        id:    row.dataset.attrId || foundry.utils.randomID(),
        label: (row.querySelector('[data-field="label"]')?.value ?? "").trim(),
        path:  (row.querySelector('[data-field="path"]')?.value  ?? "").trim()
      }))
      .filter(a => a.path);

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._itemType.id || foundry.utils.randomID(),
      systemType,
      label,
      attributes
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
