import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class AttributePickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _systemType;

  constructor(systemType, options = {}) {
    super(options);
    this._systemType = systemType;
  }

  get title() {
    return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.attributePicker.title");
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-attribute-picker`,
    position: { width: 440, height: 500 },
    window: { resizable: true },
    actions: {
      toggleAttribute:  AttributePickerApp.#onToggleAttribute,
      confirmSelection: AttributePickerApp.#onConfirmSelection,
      cancelSelection:  AttributePickerApp.#onCancelSelection
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/settings/attribute-picker.hbs`,
      scrollable: [".attr-path-list"]
    }
  };

  static async open(systemType) {
    return new Promise(resolve => {
      const existing = foundry.applications.instances.get(`${MODULE_ID}-attribute-picker`);
      if (existing) existing.close();
      const app = new AttributePickerApp(systemType);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    let paths = [];

    // TypeDataModel systems (Foundry v11+)
    const DataModelClass = CONFIG.Item?.dataModels?.[this._systemType];
    if (DataModelClass) {
      try {
        const instance = new DataModelClass({}, { parent: null });
        const obj = typeof instance.toObject === "function" ? instance.toObject() : instance;
        paths = Object.keys(foundry.utils.flattenObject(obj)).map(p => `system.${p}`).sort();
      } catch { /* fallback */ }
    }

    // Legacy template.json model
    if (!paths.length) {
      const model = game.model.Item?.[this._systemType] ?? {};
      paths = Object.keys(foundry.utils.flattenObject(model)).map(p => `system.${p}`).sort();
    }

    // Last resort: sample a world item of this type
    if (!paths.length) {
      const sample = game.items.find(i => i.type === this._systemType);
      if (sample?.system) {
        paths = Object.keys(foundry.utils.flattenObject(sample.system)).map(p => `system.${p}`).sort();
      }
    }

    return {
      systemType: this._systemType,
      paths: paths.map(path => ({ path, defaultLabel: path.split(".").pop() }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const filterInput = this.element.querySelector(".attr-filter-input");
    const list = this.element.querySelector(".attr-path-list");
    filterInput?.addEventListener("input", () => {
      const q = filterInput.value.trim().toLowerCase();
      list?.querySelectorAll(".attr-path-row").forEach(row => {
        row.hidden = q.length > 0 && !row.dataset.path.toLowerCase().includes(q);
      });
    });
    this.#updateSelectedCount();
    filterInput?.focus();
  }

  /** Refresh the "{n} selected" footer label and toggle the confirm button's enabled state. */
  #updateSelectedCount() {
    const count = this.element?.querySelectorAll(".attr-path-row.is-selected").length ?? 0;
    const countEl = this.element?.querySelector(".attr-selected-count");
    if (countEl) {
      countEl.textContent = game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.attributePicker.selectedCount", { count });
    }
    const confirmBtn = this.element?.querySelector(".attr-confirm-btn");
    if (confirmBtn) confirmBtn.disabled = count === 0;
  }

  static #onToggleAttribute(event, target) {
    const row = target.closest(".attr-path-row");
    if (!row?.dataset.path) return;
    const selected = row.classList.toggle("is-selected");
    const icon = target.querySelector("i");
    if (icon) icon.className = selected ? "fa-solid fa-check" : "fa-solid fa-plus";
    this.#updateSelectedCount();
  }

  static #onConfirmSelection() {
    const rows = this.element?.querySelectorAll(".attr-path-row.is-selected") ?? [];
    const attributes = [...rows].map(row => {
      const path = row.dataset.path;
      const label = (row.querySelector(".attr-label-input")?.value ?? "").trim() || path.split(".").pop();
      return { id: foundry.utils.randomID(), label, path };
    });
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(attributes);
    this.close();
  }

  static #onCancelSelection() {
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(null);
    this.close();
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
