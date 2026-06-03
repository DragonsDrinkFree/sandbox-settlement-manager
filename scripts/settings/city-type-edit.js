import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CityTypeEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _cityType;

  constructor(cityType, options = {}) {
    super(options);
    this._cityType = cityType;
  }

  // Dynamic title: "Add City Type" for new, "Edit City Type" for existing
  get title() {
    const key = this._cityType?.name
      ? "SANDBOX_CITY_MANAGER.cityType.editTitle"
      : "SANDBOX_CITY_MANAGER.cityType.addTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-city-type-edit`,
    tag: "form",
    form: { handler: CityTypeEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 360 }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/settings/city-type-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /**
   * Open the dialog and return a Promise that resolves with the saved city type
   * object, or null if the dialog was closed without saving.
   * @param {object} [cityType={}]  Existing city type data to edit, or empty for add.
   * @returns {Promise<object|null>}
   */
  static async open(cityType = {}) {
    return new Promise(resolve => {
      const app = new CityTypeEditApp(foundry.utils.deepClone(cityType));
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      cityType: this._cityType,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    // Auto-focus the name field on open
    this.element.querySelector('[name="name"]')?.focus();
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return; // block empty submission
    const resolve = this._resolve;
    this._resolve = null; // prevent _onClose from resolving again
    resolve?.({ ...this._cityType, name });
  }

  async _onClose(options) {
    await super._onClose(options);
    // Resolves with null if closed via X or Escape without saving
    this._resolve?.(null);
    this._resolve = null;
  }
}
