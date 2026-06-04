import { MODULE_ID, SETTINGS, RESOURCE_TYPE_IDS } from "../constants.js";
import { MenuConfigApp } from "../canvas/inn/menu-config-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class SubTypeEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _subType;
  _typeId = null;
  _lodgings = [];
  _menu = { courses: [] };

  constructor(subType, options = {}) {
    super(options);
    this._subType = subType;
  }

  get title() {
    const key = this._subType?.name
      ? "SANDBOX_SETTLEMENT_MANAGER.resourceType.subType.editTitle"
      : "SANDBOX_SETTLEMENT_MANAGER.resourceType.subType.addTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-sub-type-edit`,
    tag: "form",
    form: { handler: SubTypeEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 480 },
    actions: {
      addLodging:      SubTypeEditApp.#onAddLodging,
      deleteLodging:   SubTypeEditApp.#onDeleteLodging,
      configureMenu:   SubTypeEditApp.#onConfigureMenu
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/sub-type-edit.hbs`, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(subType = {}, typeId = null) {
    return new Promise(resolve => {
      const app = new SubTypeEditApp(foundry.utils.deepClone(subType));
      app._typeId = typeId;
      app._lodgings = foundry.utils.deepClone(subType.typeData?.lodgings ?? []);
      app._menu     = foundry.utils.deepClone(subType.typeData?.menu ?? { courses: [] });
      app._resolve  = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const isInn = this._typeId === RESOURCE_TYPE_IDS.INN;
    let lodgings = [];
    let currencies = [];
    let menuCourseCount = 0;
    if (isInn) {
      const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
      currencies = currencyConfig.currencies ?? [];
      const defaultCurrencyId = currencies[0]?.id ?? "";
      lodgings = this._lodgings.map(l => ({
        ...l,
        autoWeekly: !l.pricePerWeek,
        pricePerDay:  l.pricePerDay  ?? { currencyId: defaultCurrencyId, amount: 0 },
        pricePerWeek: l.pricePerWeek ?? { currencyId: defaultCurrencyId, amount: 0 }
      }));
      menuCourseCount = (this._menu.courses ?? []).length;
    }
    return {
      subType: this._subType,
      isInn,
      lodgings,
      currencies,
      menuCourseCount,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
    if (this._typeId === RESOURCE_TYPE_IDS.INN) this.#wireAutoWeekly();
  }

  #wireAutoWeekly() {
    this.element.querySelectorAll('.lodging-inline-row').forEach(row => {
      const autoCheckbox = row.querySelector('[data-field="autoWeekly"]');
      const weeklyFields = row.querySelectorAll('.weekly-field');
      const toggle = () => weeklyFields.forEach(el => { el.hidden = !!autoCheckbox?.checked; });
      toggle();
      autoCheckbox?.addEventListener("change", toggle);
    });
  }

  // Read all inline lodging row values from the DOM into _lodgings.
  #syncLodgingsFromDOM() {
    const rows = this.element?.querySelectorAll('.lodging-inline-row') ?? [];
    this._lodgings = [...rows].map(row => this.#rowToLodging(row));
  }

  #rowToLodging(row) {
    const autoWeekly  = !!row.querySelector('[data-field="autoWeekly"]')?.checked;
    const pdCurrencyId = row.querySelector('[data-field="pricePerDayCurrencyId"]')?.value ?? "";
    return {
      id:       row.dataset.lodgingId || foundry.utils.randomID(),
      name:     (row.querySelector('[data-field="name"]')?.value ?? "").trim(),
      beds:     Math.max(1, parseInt(row.querySelector('[data-field="beds"]')?.value) || 1),
      infinite: !!row.querySelector('[data-field="infinite"]')?.checked,
      pricePerDay: {
        currencyId: pdCurrencyId,
        amount:     parseFloat(row.querySelector('[data-field="pricePerDayAmount"]')?.value) || 0
      },
      pricePerWeek: autoWeekly ? null : {
        currencyId: row.querySelector('[data-field="pricePerWeekCurrencyId"]')?.value ?? pdCurrencyId,
        amount:     parseFloat(row.querySelector('[data-field="pricePerWeekAmount"]')?.value) || 0
      }
    };
  }

  #syncSubTypeName() {
    this._subType.name = this.element.querySelector('[name="name"]')?.value ?? this._subType.name;
  }

  static async #onConfigureMenu() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    await MenuConfigApp.open(
      foundry.utils.deepClone(this._menu),
      (updatedMenu) => { this._menu = updatedMenu; }
    );
    // Re-render to update the course count badge
    this.render({ parts: ["form"] });
  }

  static #onAddLodging() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const defaultCurrencyId = currencyConfig.currencies?.[0]?.id ?? "";
    this._lodgings.push({
      id: foundry.utils.randomID(),
      name: "",
      beds: 1,
      infinite: true,
      pricePerDay:  { currencyId: defaultCurrencyId, amount: 0 },
      pricePerWeek: null
    });
    this.render({ parts: ["form"] });
  }

  static #onDeleteLodging(event, target) {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const index = parseInt(target.dataset.index);
    this._lodgings.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;

    const result = { ...this._subType, name };
    if (this._typeId === RESOURCE_TYPE_IDS.INN) {
      const rows = form.querySelectorAll('.lodging-inline-row');
      const lodgings = [...rows]
        .map(row => this.#rowToLodging(row))
        .filter(l => l.name);
      result.typeData = { lodgings, menu: this._menu };
    }

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(result);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
