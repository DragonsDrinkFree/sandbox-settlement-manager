import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ResourceTypeEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _resourceType;

  constructor(resourceType, options = {}) {
    super(options);
    this._resourceType = resourceType;
    this._resourceType.subTypes ??= [];
  }

  get title() {
    const key = this._resourceType?.name
      ? "SANDBOX_CITY_MANAGER.resourceType.editTitle"
      : "SANDBOX_CITY_MANAGER.resourceType.addTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-resource-type-edit`,
    tag: "form",
    form: { handler: ResourceTypeEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    actions: {
      addSubType: ResourceTypeEditApp.#onAddSubType,
      removeSubType: ResourceTypeEditApp.#onRemoveSubType
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/settings/resource-type-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(resourceType = {}) {
    return new Promise(resolve => {
      const app = new ResourceTypeEditApp(foundry.utils.deepClone(resourceType));
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      resourceType: this._resourceType,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
  }

  static #onAddSubType() {
    // Sync any in-progress edits to existing sub-type names before re-rendering
    this.element.querySelectorAll('.sub-type-item [name^="subTypeName"]').forEach((input, i) => {
      if (this._resourceType.subTypes[i]) this._resourceType.subTypes[i].name = input.value;
    });
    const newName = this.element.querySelector(".new-subtype-input")?.value?.trim();
    if (!newName) return;
    this._resourceType.subTypes.push({ id: foundry.utils.randomID(), name: newName });
    this.render({ parts: ["form"] });
  }

  static #onRemoveSubType(event, target) {
    // Sync names before splicing
    this.element.querySelectorAll('.sub-type-item [name^="subTypeName"]').forEach((input, i) => {
      if (this._resourceType.subTypes[i]) this._resourceType.subTypes[i].name = input.value;
    });
    this._resourceType.subTypes.splice(parseInt(target.dataset.index), 1);
    this.render({ parts: ["form"] });
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;

    // Collect final sub-type names from DOM inputs
    const subTypeInputs = form.querySelectorAll('.sub-type-item [name^="subTypeName"]');
    subTypeInputs.forEach((input, i) => {
      if (this._resourceType.subTypes[i]) this._resourceType.subTypes[i].name = input.value.trim();
    });
    const subTypes = this._resourceType.subTypes.filter(s => s.name);

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._resourceType.id || foundry.utils.randomID(),
      name,
      icon: (formData.object.icon ?? "").trim(),
      subTypes
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
