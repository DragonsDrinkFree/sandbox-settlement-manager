import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/** Available sort criteria for merchant template inventory. */
const CRITERIA = [
  { key: "itemType", labelKey: "SANDBOX_SETTLEMENT_MANAGER.merchant.sort.byItemType" },
  { key: "itemName", labelKey: "SANDBOX_SETTLEMENT_MANAGER.merchant.sort.byItemName" },
  { key: "price",    labelKey: "SANDBOX_SETTLEMENT_MANAGER.merchant.sort.byPrice" }
];

/**
 * Configure a multi-key sort for merchant template inventory.
 * Resolves with an ordered spec `[{ key, dir }, …]` (enabled criteria, highest priority first)
 * or `null` if cancelled.
 */
export class MerchantSortDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _rows = [];

  constructor(currentSpec, options = {}) {
    super(options);
    const spec = Array.isArray(currentSpec) ? currentSpec : [];
    const rows = [];
    // Enabled criteria first, in the saved priority order.
    for (const s of spec) {
      const crit = CRITERIA.find(c => c.key === s.key);
      if (crit && !rows.some(r => r.key === crit.key)) {
        rows.push({ key: crit.key, labelKey: crit.labelKey, enabled: true, dir: s.dir === "desc" ? "desc" : "asc" });
      }
    }
    // Remaining criteria, disabled.
    for (const crit of CRITERIA) {
      if (!rows.some(r => r.key === crit.key)) {
        rows.push({ key: crit.key, labelKey: crit.labelKey, enabled: false, dir: "asc" });
      }
    }
    this._rows = rows;
  }

  get title() {
    return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.sort.title");
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-merchant-sort`,
    position: { width: 360 },
    actions: {
      moveUp:       MerchantSortDialog.#onMoveUp,
      moveDown:     MerchantSortDialog.#onMoveDown,
      confirmSort:  MerchantSortDialog.#onConfirm,
      cancelSort:   MerchantSortDialog.#onCancel
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/settings/merchant-sort-dialog.hbs` }
  };

  static async open(currentSpec) {
    return new Promise(resolve => {
      const existing = foundry.applications.instances.get(`${MODULE_ID}-merchant-sort`);
      if (existing) existing.close();
      const app = new MerchantSortDialog(currentSpec);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      rows: this._rows.map(r => ({ ...r, label: game.i18n.localize(r.labelKey) }))
    };
  }

  /** Read current checkbox/direction state and row order back into `_rows`. */
  #syncRowsFromDOM() {
    const els = [...(this.element?.querySelectorAll(".ssm-sort-row") ?? [])];
    if (!els.length) return;
    this._rows = els.map(el => {
      const key  = el.dataset.key;
      const prev = this._rows.find(r => r.key === key) ?? {};
      return {
        key,
        labelKey: prev.labelKey,
        enabled:  !!el.querySelector('[data-field="enabled"]')?.checked,
        dir:      el.querySelector('[data-field="dir"]')?.value === "desc" ? "desc" : "asc"
      };
    });
  }

  #move(key, delta) {
    this.#syncRowsFromDOM();
    const i = this._rows.findIndex(r => r.key === key);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= this._rows.length) return;
    [this._rows[i], this._rows[j]] = [this._rows[j], this._rows[i]];
    this.render({ parts: ["content"] });
  }

  static #onMoveUp(event, target)   { this.#move(target.closest(".ssm-sort-row")?.dataset.key, -1); }
  static #onMoveDown(event, target) { this.#move(target.closest(".ssm-sort-row")?.dataset.key,  1); }

  static #onConfirm() {
    this.#syncRowsFromDOM();
    const spec = this._rows.filter(r => r.enabled).map(r => ({ key: r.key, dir: r.dir }));
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(spec);
    this.close();
  }

  static #onCancel() {
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
