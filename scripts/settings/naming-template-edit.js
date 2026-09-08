import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Modal editor for one Stable Naming Template: a name plus an ordered list of "pieces", each a
 * dragged-in RollTable (world or compendium) and a connector describing what (if anything) joins
 * it to the next piece's roll. Modeled on CurrencyEditApp (currency-edit.js) — open() resolves the
 * saved `{id, name, pieces}` or null on cancel (unsaved close resolves null via _onClose, same as
 * every other modal editor in this module).
 */
export class NamingTemplateEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _template;
  #searchPopover = null; // body-mounted (see reference/foundry-reference/Body-mounted-Pickers.md) —
                          // persists across this app's own re-renders, so adding several tables in a
                          // row doesn't require reopening it; removed on close.
  #searchAbort = null;

  constructor(template, options = {}) {
    super(options);
    this._template = template;
  }

  get title() {
    const key = this._template?.name
      ? "SANDBOX_SETTLEMENT_MANAGER.stable.namingTemplateEditTitle"
      : "SANDBOX_SETTLEMENT_MANAGER.stable.namingTemplateAddTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-naming-template-edit`,
    tag: "form",
    form: { handler: NamingTemplateEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 480 },
    actions: {
      deletePiece: NamingTemplateEditApp.#onDeletePiece
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/naming-template-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Resolves the saved `{id, name, pieces}`, or null if closed without saving. */
  static async open(existing = null) {
    return new Promise(resolve => {
      const template = existing
        ? foundry.utils.deepClone(existing)
        : { id: foundry.utils.randomID(), name: "", pieces: [] };
      const app = new NamingTemplateEditApp(template);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const connectorOptions = (current) => [
      { value: "none",   label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.connectorNone") },
      { value: "space",  label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.connectorSpace") },
      { value: "custom", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.connectorCustom") }
    ].map(o => ({ ...o, selected: (current ?? "none") === o.value }));

    return {
      template: this._template,
      pieces: (this._template.pieces ?? []).map((p, i) => ({
        ...p,
        index: i,
        isCustom: p.connector === "custom",
        connectorOptions: connectorOptions(p.connector)
      })),
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#wireDropZone();
    this.#wireConnectorToggles();
    this.#setupDragSort();
    this.#wireTableSearch();
    // Re-renders happen while the popover may be open (e.g. deleting a piece) — don't steal focus
    // from it back to the name field in that case.
    if (!this.#searchPopover?.classList.contains('is-open')) {
      this.element.querySelector('[name="name"]')?.focus();
    }
  }

  #wireDropZone() {
    const dropZone = this.element.querySelector('.naming-piece-drop-zone');
    if (!dropZone) return;
    dropZone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
    dropZone.addEventListener('drop', async e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      let data;
      try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (data?.type !== 'RollTable') return;

      const table = await fromUuid(data.uuid).catch(() => null);
      if (!table) return;

      this.#syncNameFromDOM();
      this.#syncPiecesFromDOM();
      this._template.pieces.push({
        id: foundry.utils.randomID(),
        tableUuid: table.uuid,
        tableName: table.name,
        connector: "none",
        customSymbol: ""
      });
      this.render({ parts: ['form'] });
    });
  }

  /**
   * A body-mounted filter popover, anchored under the "Add Table" button — escapes the window's own
   * overflow/stacking context (see reference/foundry-reference/Body-mounted-Pickers.md). Filters
   * across both world Rollable Tables and every RollTable compendium's index; each result has its
   * own "+" to add it as a piece without closing the popover, so several can be added in a row.
   * Closes on an outside click. The popover element itself is created once and reused across this
   * app's re-renders — only the trigger button (recreated by every render) is rewired each time.
   */
  #wireTableSearch() {
    const trigger = this.element.querySelector('.naming-add-table-btn');
    if (!trigger) return;

    if (!this.#searchPopover) {
      this.#searchAbort = new AbortController();
      const { signal } = this.#searchAbort;

      const popover = document.createElement('div');
      popover.className = 'naming-table-search-popover';
      popover.innerHTML = `
        <input type="text" class="naming-table-search-input"
               placeholder="${foundry.utils.escapeHTML(game.i18n.localize('SANDBOX_SETTLEMENT_MANAGER.stable.tableSearchPlaceholder'))}">
        <ul class="item-search-results naming-table-search-results"></ul>
      `;
      document.body.appendChild(popover);
      this.#searchPopover = popover;

      const searchInput = popover.querySelector('.naming-table-search-input');
      const resultsList  = popover.querySelector('.naming-table-search-results');
      searchInput.addEventListener('input', () => this.#refreshTableSearchResults(searchInput, resultsList), { signal });

      document.addEventListener('click', e => {
        if (popover.contains(e.target) || e.target.closest('.naming-add-table-btn')) return;
        popover.classList.remove('is-open');
      }, { signal });
    }

    const popover = this.#searchPopover;
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      if (popover.classList.contains('is-open')) { popover.classList.remove('is-open'); return; }
      const rect = trigger.getBoundingClientRect();
      popover.style.top  = `${rect.bottom + 4}px`;
      popover.style.left = `${rect.left}px`;
      popover.classList.add('is-open');
      popover.querySelector('.naming-table-search-input')?.focus();
    });
  }

  #refreshTableSearchResults(searchInput, resultsList) {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) { resultsList.innerHTML = ""; return; }

    const worldMatches = game.tables.contents
      .filter(t => t.name.toLowerCase().includes(query))
      .map(t => ({ uuid: t.uuid, name: t.name, img: t.img, fromPack: false }));

    const packMatches = [];
    for (const pack of game.packs) {
      if (pack.documentName !== "RollTable") continue;
      for (const entry of pack.index) {
        if (entry.name.toLowerCase().includes(query))
          packMatches.push({ uuid: entry.uuid, name: entry.name, img: entry.img, fromPack: true });
      }
    }

    const matches = [...worldMatches, ...packMatches].slice(0, 12);

    resultsList.innerHTML = matches
      .map(t => `<li class="item-search-result naming-table-search-result">
        ${t.img ? `<img src="${t.img}" width="18" height="18">` : ""}
        <span>${t.name}</span>${t.fromPack ? `<em class="item-search-pack-tag">(Compendium)</em>` : ""}
        <button type="button" class="icon naming-table-add-btn" data-uuid="${t.uuid}" aria-label="Add">
          <i class="fa-solid fa-plus"></i>
        </button>
      </li>`)
      .join("");

    resultsList.querySelectorAll('.naming-table-add-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const table = await fromUuid(btn.dataset.uuid).catch(() => null);
        if (!table) return;
        this.#syncNameFromDOM();
        this.#syncPiecesFromDOM();
        this._template.pieces.push({
          id: foundry.utils.randomID(),
          tableUuid: table.uuid,
          tableName: table.name,
          connector: "none",
          customSymbol: ""
        });
        this.render({ parts: ['form'] });
      });
    });
  }

  /** Shows/hides each row's custom-symbol input based on its connector select, live (no re-render). */
  #wireConnectorToggles() {
    this.element.querySelectorAll('.naming-piece-row').forEach(row => {
      const select = row.querySelector('[data-field="connector"]');
      const customInput = row.querySelector('[data-field="customSymbol"]');
      if (!select || !customInput) return;
      const apply = () => { customInput.hidden = select.value !== 'custom'; };
      apply();
      select.addEventListener('change', apply);
    });
  }

  /** Drag-reorder pieces, keyed by piece id (order-independent of index shifting mid-drag). */
  #setupDragSort() {
    const list = this.element.querySelector('.naming-piece-list');
    if (!list) return;
    let dragSrc = null;

    list.addEventListener('dragstart', e => {
      dragSrc = e.target.closest('.naming-piece-row');
      if (!dragSrc) return;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => dragSrc?.classList.add('dragging'), 0);
    });

    list.addEventListener('dragover', e => {
      if (!dragSrc) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.target.closest('.naming-piece-row');
      if (!target || target === dragSrc) return;
      const { top, height } = target.getBoundingClientRect();
      if (e.clientY < top + height / 2) list.insertBefore(dragSrc, target);
      else list.insertBefore(dragSrc, target.nextSibling);
    });

    list.addEventListener('dragend', () => {
      dragSrc?.classList.remove('dragging');
      if (!dragSrc) return;
      this.#syncNameFromDOM();
      this.#syncPiecesFromDOM();
      const byId = new Map(this._template.pieces.map(p => [p.id, p]));
      this._template.pieces = [...list.querySelectorAll('.naming-piece-row')]
        .map(row => byId.get(row.dataset.pieceId))
        .filter(Boolean);
      dragSrc = null;
      this.render({ parts: ['form'] });
    });
  }

  #syncNameFromDOM() {
    this._template.name = this.element.querySelector('[name="name"]')?.value ?? this._template.name;
  }

  /** tableUuid/tableName are carried through unedited — only connector/customSymbol are editable. */
  #syncPiecesFromDOM() {
    const rows = this.element?.querySelectorAll('.naming-piece-row') ?? [];
    const byId = new Map(this._template.pieces.map(p => [p.id, p]));
    this._template.pieces = [...rows].map(row => {
      const id = row.dataset.pieceId;
      const existing = byId.get(id);
      if (!existing) return null;
      return {
        ...existing,
        connector: row.querySelector('[data-field="connector"]')?.value ?? existing.connector ?? "none",
        customSymbol: row.querySelector('[data-field="customSymbol"]')?.value ?? existing.customSymbol ?? ""
      };
    }).filter(Boolean);
  }

  static #onDeletePiece(event, target) {
    this.#syncNameFromDOM();
    this.#syncPiecesFromDOM();
    const index = parseInt(target.dataset.index);
    this._template.pieces.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    this.#syncPiecesFromDOM();
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._template.id || foundry.utils.randomID(),
      name,
      pieces: this._template.pieces
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    // Body-mounted elements aren't children of this app's root, so they don't clean up on their own.
    this.#searchAbort?.abort();
    this.#searchPopover?.remove();
    this.#searchPopover = null;
    this._resolve?.(null);
    this._resolve = null;
  }
}
