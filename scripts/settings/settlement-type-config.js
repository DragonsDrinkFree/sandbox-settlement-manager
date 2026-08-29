import { MODULE_ID, SETTINGS } from "../constants.js";
import { SettlementTypeEditApp } from "./settlement-type-edit.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export const DEFAULT_SETTLEMENT_TYPES = [
  { name: "Village" },
  { name: "Town" },
  { name: "City" }
];

export class SettlementTypeConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  // Working copy — null until first _prepareContext, not saved until Save is clicked
  _types = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-settlement-type-config`,
    tag: "form",
    form: { handler: SettlementTypeConfigApp.#onSubmit, closeOnSubmit: true },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.setting.settlementTypeConfig.name" },
    position: { width: 460 },
    actions: {
      addSettlementType: SettlementTypeConfigApp.#onAddSettlementType,
      editSettlementType: SettlementTypeConfigApp.#onEditSettlementType,
      deleteSettlementType: SettlementTypeConfigApp.#onDeleteSettlementType,
      resetToDefaults: SettlementTypeConfigApp.#onResetToDefaults
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/settings/settlement-type-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    if (this._types === null) {
      this._types = game.settings.get(MODULE_ID, SETTINGS.SETTLEMENT_TYPES).map(t => foundry.utils.deepClone(t));
    }
    return {
      settlementTypes: this._types,
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
    const list = this.element.querySelector(".settlement-type-list");
    if (!list) return;
    let dragSrc = null;

    list.addEventListener("dragstart", e => {
      dragSrc = e.target.closest(".settlement-type-item");
      if (!dragSrc) return;
      e.dataTransfer.effectAllowed = "move";
      // defer so the drag ghost renders before the opacity change
      setTimeout(() => dragSrc?.classList.add("dragging"), 0);
    });

    list.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const target = e.target.closest(".settlement-type-item");
      if (!target || target === dragSrc) return;
      const { top, height } = target.getBoundingClientRect();
      if (e.clientY < top + height / 2) list.insertBefore(dragSrc, target);
      else list.insertBefore(dragSrc, target.nextSibling);
    });

    list.addEventListener("dragend", () => {
      dragSrc?.classList.remove("dragging");
      if (!dragSrc) return;
      const snapshot = this._types.slice();
      this._types = Array.from(list.querySelectorAll(".settlement-type-item"))
        .map(item => snapshot[parseInt(item.dataset.index)])
        .filter(Boolean);
      dragSrc = null;
      this.render({ parts: ["form"] });
    });
  }

  /**
   * Persist the current type list immediately, independent of this app's own outer save. The
   * settings key holds only this array — no sibling fields to preserve, so this is a direct write.
   */
  async #persistTypesNow() {
    await game.settings.set(MODULE_ID, SETTINGS.SETTLEMENT_TYPES, this._types);
  }

  static async #onAddSettlementType() {
    const result = await SettlementTypeEditApp.open({});
    if (!result) return;
    this._types.push(result);
    await this.#persistTypesNow();
    this.render({ parts: ["form"] });
  }

  static async #onEditSettlementType(event, target) {
    const index = parseInt(target.dataset.index);
    const result = await SettlementTypeEditApp.open(this._types[index]);
    if (!result) return;
    this._types[index] = result;
    await this.#persistTypesNow();
    this.render({ parts: ["form"] });
  }

  static async #onDeleteSettlementType(event, target) {
    this._types.splice(parseInt(target.dataset.index), 1);
    await this.#persistTypesNow();
    this.render({ parts: ["form"] });
  }

  static #onResetToDefaults() {
    this._types = DEFAULT_SETTLEMENT_TYPES.map(t => ({ ...t }));
    this.render({ parts: ["form"] });
  }

  static async #onSubmit() {
    await game.settings.set(MODULE_ID, SETTINGS.SETTLEMENT_TYPES, this._types);
  }
}
