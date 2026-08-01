import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Shared multi-select actor picker for granting Storage Group access — used by the GM's
 * StorageGroupEditApp (any level, defaults to Primary) and the player-facing
 * StorageAccessManageApp (Guest only, no level choice). The caller is responsible for
 * pre-filtering `candidateActors` (excluding existing members, and — for the player-facing case —
 * to actors the current user owns or has Observer permission on).
 */
export class StorageAccessAddApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _candidateActors;   // [{ id, name, type, hasPlayerOwner }]
  _allowLevelChoice;

  constructor(candidateActors, { allowLevelChoice = false } = {}, options = {}) {
    super(options);
    this._candidateActors  = candidateActors;
    this._allowLevelChoice = allowLevelChoice;
  }

  get title() { return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.access.addTitle"); }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-storage-access-add`,
    tag: "form",
    form: { handler: StorageAccessAddApp.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    actions: {
      cancel: StorageAccessAddApp.#onCancel
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/storage-access-add.hbs`, scrollable: [".storage-access-list"] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Open the picker. Resolves with [{ actorId, level }, ...] for the checked rows, or null if cancelled. */
  static async open(candidateActors, { allowLevelChoice = false } = {}) {
    return new Promise(resolve => {
      const app = new StorageAccessAddApp(candidateActors, { allowLevelChoice });
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      allowLevelChoice: this._allowLevelChoice,
      actorRows: this._candidateActors,
      buttons: [
        { type: "submit", icon: "fa-solid fa-plus",   label: "SANDBOX_SETTLEMENT_MANAGER.storage.access.add" },
        { type: "button", action: "cancel", icon: "fa-solid fa-xmark", label: "SANDBOX_SETTLEMENT_MANAGER.dialog.cancel" }
      ]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    const filterInput = this.element.querySelector('.storage-access-filter');
    filterInput?.addEventListener('input', () => {
      this._searchQuery = filterInput.value.trim().toLowerCase();
      this.#applyFilters();
    });
    this._searchQuery = '';
    this._typeFilter = { playerOwned: false, types: null };
    this.#wireFilterBtn();
  }

  #applyFilters() {
    const q = this._searchQuery;
    const { playerOwned, types } = this._typeFilter;
    this.element.querySelectorAll('.storage-access-add-row').forEach(row => {
      const matchesText  = !q || (row.dataset.actorName ?? "").toLowerCase().includes(q);
      const matchesOwned = !playerOwned || row.dataset.playerOwned === "1";
      const matchesType  = !types || types.has(row.dataset.actorType);
      row.hidden = !(matchesText && matchesOwned && matchesType);
    });
  }

  #wireFilterBtn() {
    const btn = this.element.querySelector('.storage-access-filter-btn');
    if (!btn) return;

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const existing = document.querySelector('.ssm-actor-filter-menu');
      if (existing) { existing.remove(); this.#commitFilterMenu(existing, btn); return; }

      const types = Object.entries(CONFIG.Actor.typeLabels ?? {}).map(([id, label]) => ({
        id, label: typeof label === 'string' ? game.i18n.localize(label) : id,
        checked: !this._typeFilter.types || this._typeFilter.types.has(id)
      }));
      const menu = document.createElement('div');
      menu.className = 'ssm-actor-filter-menu';
      menu.innerHTML = `
        <label class="ssm-af-row"><input type="checkbox" class="ssm-af-player-owned"${this._typeFilter.playerOwned ? ' checked' : ''}> ${game.i18n.localize('SANDBOX_SETTLEMENT_MANAGER.actor.playerOwned')}</label>
        <hr class="ssm-af-divider">
        ${types.map(t => `<label class="ssm-af-row"><input type="checkbox" class="ssm-af-type" data-type="${t.id}"${t.checked ? ' checked' : ''}> ${t.label}</label>`).join('')}
      `;
      const rect = btn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top  = `${rect.bottom + 2}px`;
      menu.style.left = `${rect.left}px`;
      document.body.appendChild(menu);
      menu.addEventListener('click', e => e.stopPropagation());
      menu.addEventListener('change', () => this.#commitFilterMenu(menu, btn));
      document.addEventListener('click', () => {
        if (!menu.isConnected) return;
        menu.remove();
        this.#commitFilterMenu(menu, btn);
      }, { once: true });
    });
  }

  #commitFilterMenu(menu, btn) {
    const playerOwned  = menu.querySelector('.ssm-af-player-owned')?.checked ?? false;
    const typeCbs      = [...menu.querySelectorAll('.ssm-af-type')];
    const allChecked   = typeCbs.every(cb => cb.checked);
    const checkedTypes = typeCbs.filter(cb => cb.checked).map(cb => cb.dataset.type);
    this._typeFilter = { playerOwned, types: allChecked ? null : (checkedTypes.length ? new Set(checkedTypes) : null) };
    btn.classList.toggle('active', playerOwned || this._typeFilter.types !== null);
    this.#applyFilters();
  }

  static #onCancel() {
    this.close();
  }

  static async #onSubmit(event, form, formData) {
    const rows = [...form.querySelectorAll('.storage-access-add-checkbox:checked')];
    const entries = rows.map(cb => {
      const actorId = cb.dataset.actorId;
      const level = this._allowLevelChoice
        ? (form.querySelector(`.storage-access-add-level-select[data-actor-id="${actorId}"]`)?.value ?? "primary")
        : "guest";
      return { actorId, level };
    });

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(entries.length ? entries : null);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
