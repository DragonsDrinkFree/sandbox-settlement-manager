import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only dialog for creating/editing a Storage Group: its name, which Storage Type it draws
 * capacity/default policy from, an optional per-group retrieval-policy override, and the explicit
 * list of actors granted access. Access lists are instance-only (never template data) — they're
 * assigned here, at the location level, not on the reusable Storage Type.
 */
export class StorageGroupEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _group;         // { id, name, storageTypeId, accessActorIds, retrievalPolicyOverride }
  _storageTypes;  // [{ id, name }]
  _actors;        // [{ id, name, type, hasPlayerOwner }]
  _accessSearchQuery = "";
  _accessFilter = { playerOwned: false, types: null };

  constructor(group, { storageTypes, actors }, options = {}) {
    super(options);
    this._group        = group;
    this._storageTypes = storageTypes;
    this._actors        = actors;
  }

  get title() {
    return game.i18n.localize(
      this._group?.id
        ? "SANDBOX_SETTLEMENT_MANAGER.storage.group.editTitle"
        : "SANDBOX_SETTLEMENT_MANAGER.storage.group.addTitle"
    );
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-storage-group-edit`,
    tag: "form",
    form: { handler: StorageGroupEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    actions: {
      cancel: StorageGroupEditApp.#onCancel
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/storage-group-edit.hbs`, scrollable: [".storage-access-list"] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Open the dialog. Resolves with the edited group, or null if cancelled. */
  static async open(group, context) {
    return new Promise(resolve => {
      const app = new StorageGroupEditApp(foundry.utils.deepClone(group), context);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      name: this._group.name ?? "",
      storageTypeOptions: this._storageTypes.map(st => ({
        id: st.id, name: st.name, selected: st.id === this._group.storageTypeId
      })),
      policyOptions: [
        { value: "",              label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.group.policyInherit"),        selected: !this._group.retrievalPolicyOverride },
        { value: "anyone",        label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.policyAnyone"),               selected: this._group.retrievalPolicyOverride === "anyone" },
        { value: "depositorOnly", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.policyDepositorOnly"),        selected: this._group.retrievalPolicyOverride === "depositorOnly" }
      ],
      actorRows: this._actors.map(a => ({
        id: a.id, name: a.name, type: a.type, hasPlayerOwner: a.hasPlayerOwner,
        checked: (this._group.accessActorIds ?? []).includes(a.id)
      })),
      buttons: [
        { type: "submit", icon: "fa-solid fa-save",   label: "Save" },
        { type: "button", action: "cancel", icon: "fa-solid fa-xmark", label: "SANDBOX_SETTLEMENT_MANAGER.dialog.cancel" }
      ]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();

    const filterInput = this.element.querySelector('.storage-access-filter');
    filterInput?.addEventListener('input', () => {
      this._accessSearchQuery = filterInput.value.trim().toLowerCase();
      this.#applyAccessFilters();
    });

    this.#wireAccessFilterBtn();
  }

  /** Hide access-list rows that don't match both the text search and the type/player-owned filter. */
  #applyAccessFilters() {
    const q = this._accessSearchQuery;
    const { playerOwned, types } = this._accessFilter;
    this.element.querySelectorAll('.storage-access-row').forEach(row => {
      const matchesText  = !q || (row.dataset.actorName ?? "").toLowerCase().includes(q);
      const matchesOwned = !playerOwned || row.dataset.playerOwned === "1";
      const matchesType  = !types || types.has(row.dataset.actorType);
      row.hidden = !(matchesText && matchesOwned && matchesType);
    });
  }

  /**
   * Actor-type/player-owned filter menu, matching the one used by the Bank/Sell actor pickers
   * (location-detail-app.js / settlement-manage-app.js #wireActorFilterMenu). Unlike that version,
   * this list is a small static in-memory array (no server re-fetch needed), so changes apply live
   * as each box is toggled rather than deferring to close — the menu itself still only closes via an
   * outside click or a second click of the filter button (true toggle-close), matching that fix.
   */
  #wireAccessFilterBtn() {
    const btn = this.element.querySelector('.storage-access-filter-btn');
    if (!btn) return;

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const existing = document.querySelector('.ssm-actor-filter-menu');
      if (existing) {
        existing.remove();
        this.#commitAccessMenu(existing, btn);
        return;
      }

      const types = Object.entries(CONFIG.Actor.typeLabels ?? {}).map(([id, label]) => ({
        id,
        label: typeof label === 'string' ? game.i18n.localize(label) : id,
        checked: !this._accessFilter.types || this._accessFilter.types.has(id)
      }));

      const menu = document.createElement('div');
      menu.className = 'ssm-actor-filter-menu';
      menu.innerHTML = `
        <label class="ssm-af-row"><input type="checkbox" class="ssm-af-player-owned"${this._accessFilter.playerOwned ? ' checked' : ''}> ${game.i18n.localize('SANDBOX_SETTLEMENT_MANAGER.actor.playerOwned')}</label>
        <hr class="ssm-af-divider">
        ${types.map(t => `<label class="ssm-af-row"><input type="checkbox" class="ssm-af-type" data-type="${t.id}"${t.checked ? ' checked' : ''}> ${t.label}</label>`).join('')}
      `;

      const rect = btn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top  = `${rect.bottom + 2}px`;
      menu.style.left = `${rect.left}px`;
      document.body.appendChild(menu);

      menu.addEventListener('click', e => e.stopPropagation());
      menu.addEventListener('change', () => this.#commitAccessMenu(menu, btn));
      document.addEventListener('click', () => {
        if (!menu.isConnected) return;
        menu.remove();
        this.#commitAccessMenu(menu, btn);
      }, { once: true });
    });
  }

  #commitAccessMenu(menu, btn) {
    const playerOwned  = menu.querySelector('.ssm-af-player-owned')?.checked ?? false;
    const typeCbs       = [...menu.querySelectorAll('.ssm-af-type')];
    const allChecked    = typeCbs.every(cb => cb.checked);
    const checkedTypes  = typeCbs.filter(cb => cb.checked).map(cb => cb.dataset.type);
    this._accessFilter = { playerOwned, types: allChecked ? null : (checkedTypes.length ? new Set(checkedTypes) : null) };
    btn.classList.toggle('active', playerOwned || this._accessFilter.types !== null);
    this.#applyAccessFilters();
  }

  static #onCancel() {
    this.close();
  }

  static async #onSubmit(event, form, formData) {
    const name           = (formData.object.name ?? "").trim();
    const storageTypeId  = formData.object.storageTypeId ?? null;
    const policyOverride = formData.object.retrievalPolicyOverride || null;
    const accessActorIds = [...form.querySelectorAll('.storage-access-actor-checkbox:checked')]
      .map(cb => cb.dataset.actorId);

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._group.id || foundry.utils.randomID(),
      name,
      storageTypeId,
      accessActorIds,
      retrievalPolicyOverride: policyOverride
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
