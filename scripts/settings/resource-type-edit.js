import { MODULE_ID } from "../constants.js";
import { SubTypeEditApp } from "./sub-type-edit.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ResourceTypeEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _coreType;
  _subTypes;

  constructor(coreType, subTypes, options = {}) {
    super(options);
    this._coreType = coreType;
    this._subTypes = subTypes;
  }

  get title() {
    return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resourceType.editTitle");
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-resource-type-edit`,
    tag: "form",
    form: { handler: ResourceTypeEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    actions: {
      addSubType:    ResourceTypeEditApp.#onAddSubType,
      editSubType:   ResourceTypeEditApp.#onEditSubType,
      deleteSubType: ResourceTypeEditApp.#onDeleteSubType
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/resource-type-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(coreType, subTypes = []) {
    return new Promise(resolve => {
      const app = new ResourceTypeEditApp(coreType, foundry.utils.deepClone(subTypes));
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      coreType: this._coreType,
      subTypes: this._subTypes,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  static async #onAddSubType() {
    const result = await SubTypeEditApp.open({}, this._coreType.id);
    if (!result) return;
    result.id ??= foundry.utils.randomID();
    this._subTypes.push(result);
    this.render({ parts: ["form"] });
  }

  static async #onEditSubType(event, target) {
    const index = parseInt(target.dataset.subIndex);
    const existing = this._subTypes[index];
    if (!existing) return;
    const result = await SubTypeEditApp.open(existing, this._coreType.id);
    if (!result) return;
    this._subTypes[index] = result;
    this.render({ parts: ["form"] });
  }

  static #onDeleteSubType(event, target) {
    this._subTypes.splice(parseInt(target.dataset.subIndex), 1);
    this.render({ parts: ["form"] });
  }

  static async #onSubmit(event, form, formData) {
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(this._subTypes.slice());
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
