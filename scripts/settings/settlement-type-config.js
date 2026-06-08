import { MODULE_ID, SETTINGS } from "../constants.js";
import { CityTypeEditApp } from "./city-type-edit.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export const DEFAULT_CITY_TYPES = [
  { name: "Hamlet" },
  { name: "Village" },
  { name: "Small Town" },
  { name: "Large Town" },
  { name: "City" }
];

export class CityTypeConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  // Working copy — null until first _prepareContext, not saved until Save is clicked
  _types = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-city-type-config`,
    tag: "form",
    form: { handler: CityTypeConfigApp.#onSubmit, closeOnSubmit: true },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.setting.cityTypeConfig.name" },
    position: { width: 460 },
    actions: {
      addCityType: CityTypeConfigApp.#onAddCityType,
      editCityType: CityTypeConfigApp.#onEditCityType,
      deleteCityType: CityTypeConfigApp.#onDeleteCityType,
      resetToDefaults: CityTypeConfigApp.#onResetToDefaults
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/settings/city-type-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    if (this._types === null) {
      this._types = game.settings.get(MODULE_ID, SETTINGS.CITY_TYPES).map(t => foundry.utils.deepClone(t));
    }
    return {
      cityTypes: this._types,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!options.parts || options.parts.includes("form")) {
      this.#setupDragSort();
    }
  }

  #setupDragSort() {
    const list = this.element.querySelector(".city-type-list");
    if (!list) return;
    let dragSrc = null;

    list.addEventListener("dragstart", e => {
      dragSrc = e.target.closest(".city-type-item");
      if (!dragSrc) return;
      e.dataTransfer.effectAllowed = "move";
      // defer so the drag ghost renders before the opacity change
      setTimeout(() => dragSrc?.classList.add("dragging"), 0);
    });

    list.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const target = e.target.closest(".city-type-item");
      if (!target || target === dragSrc) return;
      const { top, height } = target.getBoundingClientRect();
      if (e.clientY < top + height / 2) list.insertBefore(dragSrc, target);
      else list.insertBefore(dragSrc, target.nextSibling);
    });

    list.addEventListener("dragend", () => {
      dragSrc?.classList.remove("dragging");
      if (!dragSrc) return;
      const snapshot = this._types.slice();
      this._types = Array.from(list.querySelectorAll(".city-type-item"))
        .map(item => snapshot[parseInt(item.dataset.index)])
        .filter(Boolean);
      dragSrc = null;
      this.render({ parts: ["form"] });
    });
  }

  static async #onAddCityType() {
    const result = await CityTypeEditApp.open({});
    if (!result) return;
    this._types.push(result);
    this.render({ parts: ["form"] });
  }

  static async #onEditCityType(event, target) {
    const index = parseInt(target.dataset.index);
    const result = await CityTypeEditApp.open(this._types[index]);
    if (!result) return;
    this._types[index] = result;
    this.render({ parts: ["form"] });
  }

  static #onDeleteCityType(event, target) {
    this._types.splice(parseInt(target.dataset.index), 1);
    this.render({ parts: ["form"] });
  }

  static #onResetToDefaults() {
    this._types = DEFAULT_CITY_TYPES.map(t => ({ ...t }));
    this.render({ parts: ["form"] });
  }

  static async #onSubmit() {
    await game.settings.set(MODULE_ID, SETTINGS.CITY_TYPES, this._types);
  }
}
