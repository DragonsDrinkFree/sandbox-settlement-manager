import { MODULE_ID, SETTINGS, CORE_RESOURCE_TYPES } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ResourceEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _resource;

  constructor(resource, options = {}) {
    super(options);
    this._resource = resource;
  }

  get title() {
    const key = this._resource?.name
      ? "SANDBOX_CITY_MANAGER.resource.editTitle"
      : "SANDBOX_CITY_MANAGER.resource.addTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-resource-edit`,
    tag: "form",
    form: { handler: ResourceEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 380 }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/canvas/resource-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(resource = {}) {
    return new Promise(resolve => {
      const app = new ResourceEditApp(foundry.utils.deepClone(resource));
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const subTypeMap = this.#getSubTypeMap();
    const subTypes = subTypeMap[this._resource.typeId] ?? [];
    return {
      resource: this._resource,
      resourceTypes: CORE_RESOURCE_TYPES.map(t => ({ value: t.id, label: t.name })),
      subTypes,
      hasSubTypes: subTypes.length > 0,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  #getSubTypeMap() {
    const raw = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    return Array.isArray(raw) ? {} : (raw ?? {});
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
    this.element.querySelector('[name="typeId"]')?.addEventListener("change", e => {
      this.#updateSubTypeOptions(e.target.value);
    });
  }

  #updateSubTypeOptions(typeId) {
    const subTypeMap = this.#getSubTypeMap();
    const subTypes = subTypeMap[typeId] ?? [];
    const container = this.element.querySelector(".sub-type-group");
    if (!container) return;
    if (!subTypes.length) {
      container.style.display = "none";
      return;
    }
    container.style.display = "";
    const select = container.querySelector('[name="subTypeId"]');
    select.innerHTML = `<option value="">— None —</option>` +
      subTypes.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
    select.value = "";
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._resource.id || foundry.utils.randomID(),
      typeId: formData.object.typeId ?? "",
      subTypeId: formData.object.subTypeId || null,
      name,
      ownerId: null,
      discovered: {
        default: !!formData.object.discovered,
        parties: {}
      },
      typeData: this._resource.typeData ?? { expenses: [] }
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
