import { MODULE_ID, SETTINGS } from "../constants.js";
import { CurrencyEditApp } from "./currency-edit.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export const DEFAULT_CURRENCIES = [
  { id: "gold",   name: "Gold",   abbreviation: "gp", isStandard: true,  exchangeRate: "1:1",   attributePath: "", itemId: "", itemName: "" },
  { id: "silver", name: "Silver", abbreviation: "sp", isStandard: false, exchangeRate: "1:10",  attributePath: "", itemId: "", itemName: "" },
  { id: "copper", name: "Copper", abbreviation: "cp", isStandard: false, exchangeRate: "1:100", attributePath: "", itemId: "", itemName: "" }
];

export class CurrencyConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _config = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-currency-config`,
    tag: "form",
    form: { handler: CurrencyConfigApp.#onSubmit, closeOnSubmit: true },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.setting.currencyConfig.name" },
    position: { width: 540 },
    actions: {
      addCurrency:     CurrencyConfigApp.#onAddCurrency,
      editCurrency:    CurrencyConfigApp.#onEditCurrency,
      deleteCurrency:  CurrencyConfigApp.#onDeleteCurrency,
      resetToDefaults: CurrencyConfigApp.#onResetToDefaults
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/currency-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    if (this._config === null) {
      this._config = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG));
      this._config.currencies ??= [];
      this._config.mode ??= "loose";
    }
    return {
      currencies: this._config.currencies,
      currentMode: this._config.mode,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!options.parts || options.parts.includes("form")) {
      this.#setupDragSort();
      this.element.querySelector('[name="mode"]')?.addEventListener("change", e => {
        this._config.mode = e.target.value;
        this.render({ parts: ["form"] });
      });
    }
  }

  #setupDragSort() {
    const list = this.element.querySelector(".currency-list");
    if (!list) return;
    let dragSrc = null;

    list.addEventListener("dragstart", e => {
      dragSrc = e.target.closest(".currency-item");
      if (!dragSrc) return;
      e.dataTransfer.effectAllowed = "move";
      setTimeout(() => dragSrc?.classList.add("dragging"), 0);
    });

    list.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const target = e.target.closest(".currency-item");
      if (!target || target === dragSrc) return;
      const { top, height } = target.getBoundingClientRect();
      if (e.clientY < top + height / 2) list.insertBefore(dragSrc, target);
      else list.insertBefore(dragSrc, target.nextSibling);
    });

    list.addEventListener("dragend", () => {
      dragSrc?.classList.remove("dragging");
      if (!dragSrc) return;
      const snapshot = this._config.currencies.slice();
      this._config.currencies = Array.from(list.querySelectorAll(".currency-item"))
        .map(item => snapshot[parseInt(item.dataset.index)])
        .filter(Boolean);
      dragSrc = null;
      this.render({ parts: ["form"] });
    });
  }

  static async #onAddCurrency() {
    const result = await CurrencyEditApp.open({}, this._config.mode);
    if (!result) return;
    if (result.isStandard) this._config.currencies.forEach(c => c.isStandard = false);
    this._config.currencies.push(result);
    this.render({ parts: ["form"] });
  }

  static async #onEditCurrency(event, target) {
    const index = parseInt(target.dataset.index);
    const result = await CurrencyEditApp.open(this._config.currencies[index], this._config.mode);
    if (!result) return;
    if (result.isStandard) {
      this._config.currencies.forEach((c, i) => { if (i !== index) c.isStandard = false; });
    }
    this._config.currencies[index] = result;
    this.render({ parts: ["form"] });
  }

  static #onDeleteCurrency(event, target) {
    this._config.currencies.splice(parseInt(target.dataset.index), 1);
    this.render({ parts: ["form"] });
  }

  static #onResetToDefaults() {
    this._config.currencies = DEFAULT_CURRENCIES.map(c => foundry.utils.deepClone(c));
    this.render({ parts: ["form"] });
  }

  static async #onSubmit() {
    await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_CONFIG, this._config);
  }
}
