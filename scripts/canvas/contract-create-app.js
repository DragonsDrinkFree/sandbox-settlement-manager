import { MODULE_ID } from "../constants.js";
import { getCurrencyContext, getStandardCurrency } from "../utils/currency-utils.js";
import { TREASURE_SHARES, treasureShareOptions, contractTermsLabel } from "../utils/contract-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only dialog for hand-authoring a Stable contract from the Contract Manager, independent of the
 * player-negotiated flow. "Link Actor" is a live name search (type to filter, click a suggestion or
 * type an exact name and click Link) across every world actor — no dropdown/filter menu, this is a
 * GM tool and every actor should be reachable by just typing its name (modelled on the item-search
 * pattern in currency-edit.js). "Hiring Character" stays the searchable actor-dropdown widget used
 * elsewhere (LoanOfferApp/PurchaseDialog/NegotiateContractApp) since it's specifically "pick one of
 * the PCs", where the dropdown-with-filter-menu affordance still earns its keep. Resolves the
 * collected terms; the caller (ContractManagerApp) builds the actual contract record and performs the
 * link/clone so it can reuse the exact same `buildContractRecord` helper the negotiated flow uses.
 */
export class ContractCreateApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _mode = "clone"; // "clone" | "link"
  _contractTerms = "wages";
  _sourceActor = null;
  _hiringActor = null;
  _hiringActorFilter = { playerOwned: true, types: null };
  #actorWidgetAbort = null;
  #actorDropdownEls = [];

  constructor(options = {}) {
    super(options);
    this._hiringActor = game.user.character
      ?? game.actors.find(a => a.hasPlayerOwner)
      ?? null;
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-contract-create`,
    tag: "form",
    form: { handler: ContractCreateApp.#onSubmit, closeOnSubmit: true },
    position: { width: 440 },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.stable.contract.createTitle" }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/contract-create.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /**
   * @returns {Promise<{ mode:"link"|"clone", sourceActorId, hiringActorId, contractTerms, wageAmount, wageCurrencyId, wagePeriod, treasureShare }|null>}
   */
  static async open() {
    return new Promise(resolve => {
      const app = new ContractCreateApp();
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const { currencies } = getCurrencyContext();
    const std = getStandardCurrency(currencies);

    const hiringFilter = (a) => {
      if (!game.user.isGM) return a.testUserPermission(game.user, "OWNER");
      if (this._hiringActorFilter.playerOwned && !a.hasPlayerOwner) return false;
      if (this._hiringActorFilter.types?.size && !this._hiringActorFilter.types.has(a.type)) return false;
      return true;
    };
    const hiringActors = game.actors.filter(hiringFilter).map(a => ({ id: a.id, name: a.name }));

    const contractTermsOptions = ["wages", "treasure", "both"].map(v => ({
      value: v, label: contractTermsLabel(v), selected: this._contractTerms === v
    }));

    return {
      mode: this._mode,
      contractTermsOptions,
      wantsWage:     this._contractTerms === "wages" || this._contractTerms === "both",
      wantsTreasure: this._contractTerms === "treasure" || this._contractTerms === "both",
      currencies,
      wagePrice: { amount: 0, currencyId: std?.id ?? currencies[0]?.id ?? "" },
      periods: ["day", "week", "month"].map(u => ({
        id: u,
        label: game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.bank.loans.period.${u}`),
        selected: u === "week"
      })),
      treasureShares: treasureShareOptions("1/2"),
      isGM: game.user.isGM,
      selectedSourceActorName: this._sourceActor?.name ?? "",
      hiringActors,
      selectedHiringActorId: this._hiringActor?.id ?? "",
      selectedHiringActorName: this._hiringActor?.name ?? "",
      hiringFilterActive: game.user.isGM && (!this._hiringActorFilter.playerOwned || this._hiringActorFilter.types !== null),
      buttons: [{ type: "submit", icon: "fa-solid fa-file-signature", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.createSubmit") }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#wireHiringActorWidget();
    this.#wireActorLinkSearch();

    this.element.querySelector('[name="contractTerms"]')?.addEventListener('change', e => {
      this._contractTerms = e.target.value;
      this.render({ parts: ["form"] });
    });
    this.element.querySelectorAll('[name="mode"]').forEach(radio => {
      radio.addEventListener('change', e => {
        if (e.target.checked) {
          this._mode = e.target.value;
          this.render({ parts: ["form"] });
        }
      });
    });
  }

  /** "Link Actor": type to search, click a suggestion or type an exact name and click Link. */
  #wireActorLinkSearch() {
    const clearBtn = this.element.querySelector('.ssm-actor-link-clear');
    clearBtn?.addEventListener('click', () => {
      this._sourceActor = null;
      this.render({ parts: ["form"] });
    });

    const searchInput = this.element.querySelector('.ssm-actor-link-search');
    const resultsList = this.element.querySelector('.ssm-actor-link-results');
    const linkBtn      = this.element.querySelector('.ssm-actor-link-btn');
    if (!searchInput || !resultsList || !linkBtn) return;

    searchInput.addEventListener('input', () => {
      delete searchInput.dataset.actorId;
      const query = searchInput.value.trim().toLowerCase();
      if (!query) { resultsList.innerHTML = ""; return; }
      const matches = game.actors.filter(a => a.name.toLowerCase().includes(query)).slice(0, 12);
      resultsList.innerHTML = matches.map(a =>
        `<li class="ssm-actor-link-result" data-actor-id="${a.id}">${foundry.utils.escapeHTML(a.name)}</li>`
      ).join("");
      resultsList.querySelectorAll('.ssm-actor-link-result').forEach(li => {
        li.addEventListener('click', () => {
          searchInput.value = li.textContent;
          searchInput.dataset.actorId = li.dataset.actorId;
          resultsList.innerHTML = "";
        });
      });
    });

    linkBtn.addEventListener('click', () => {
      let actor = searchInput.dataset.actorId ? game.actors.get(searchInput.dataset.actorId) : null;
      if (!actor) {
        // No suggestion was clicked — fall back to an exact (case-insensitive) name match so typing
        // the full name and clicking Link works without ever touching the results list.
        const typed = searchInput.value.trim().toLowerCase();
        const exact = typed ? game.actors.filter(a => a.name.toLowerCase() === typed) : [];
        if (exact.length === 1) actor = exact[0];
      }
      if (!actor) {
        ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.noSourceActorMatch"));
        return;
      }
      this._sourceActor = actor;
      this.render({ parts: ["form"] });
    });
  }

  #wireHiringActorWidget() {
    this.#actorWidgetAbort?.abort();
    this.#actorWidgetAbort = new AbortController();
    const { signal } = this.#actorWidgetAbort;
    this.#actorDropdownEls.forEach(el => el.remove());
    this.#actorDropdownEls = [];
    document.querySelector('.ssm-actor-filter-menu')?.remove();

    const hiringWidget = this.element.querySelector('.ssm-actor-dropdown-widget[data-actor-context="hiring"]');
    if (hiringWidget) {
      this.#wireActorDropdown(hiringWidget, signal, id => {
        this._hiringActor = game.actors.get(id) ?? null;
        this.render({ parts: ["form"] });
      });
    }
    const hiringFilterBtn = this.element.querySelector('.ssm-actor-filter-btn[data-actor-context="hiring"]');
    if (hiringFilterBtn) {
      this.#wireActorFilterMenu(hiringFilterBtn, this._hiringActorFilter, signal, f => {
        this._hiringActorFilter = f;
        this.render({ parts: ["form"] });
      });
    }
  }

  #wireActorDropdown(widget, signal, onSelect) {
    const trigger = widget.querySelector('.ssm-actor-dropdown-trigger');
    const list    = widget.querySelector('.ssm-actor-dropdown-list');
    if (!trigger || !list) return;
    document.body.appendChild(list);
    this.#actorDropdownEls.push(list);
    const position = () => {
      const r = trigger.getBoundingClientRect();
      list.style.top      = `${r.bottom + 2}px`;
      list.style.left     = `${r.left}px`;
      list.style.minWidth = `${r.width}px`;
    };
    const open  = () => { position(); list.classList.add('is-open'); list.querySelector('.ssm-actor-dropdown-search')?.focus(); };
    const close = () => list.classList.remove('is-open');
    trigger.addEventListener('click', e => { e.stopPropagation(); list.classList.contains('is-open') ? close() : open(); }, { signal });
    document.addEventListener('click', close, { signal });
    list.addEventListener('click', e => e.stopPropagation(), { signal });
    list.querySelector('.ssm-actor-dropdown-search')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      list.querySelectorAll('.ssm-actor-option').forEach(opt => {
        opt.style.display = (!q || opt.textContent.trim().toLowerCase().includes(q)) ? '' : 'none';
      });
    }, { signal });
    list.querySelectorAll('.ssm-actor-option').forEach(opt => {
      opt.addEventListener('click', () => { onSelect(opt.dataset.actorId || null); close(); }, { signal });
    });
  }

  #wireActorFilterMenu(btn, actorFilter, signal, onApply) {
    const applyFromMenu = (menu) => {
      const playerOwned  = menu.querySelector('.ssm-af-player-owned')?.checked ?? true;
      const typeCbs      = [...menu.querySelectorAll('.ssm-af-type')];
      const allChecked   = typeCbs.every(cb => cb.checked);
      const checkedTypes = typeCbs.filter(cb => cb.checked).map(cb => cb.dataset.type);
      onApply({ playerOwned, types: allChecked ? null : (checkedTypes.length ? new Set(checkedTypes) : null) });
    };

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const existing = document.querySelector('.ssm-actor-filter-menu');
      if (existing) {
        existing.remove();
        applyFromMenu(existing);
        return;
      }

      const types = Object.entries(CONFIG.Actor.typeLabels ?? {}).map(([id, label]) => ({
        id,
        label: typeof label === 'string' ? game.i18n.localize(label) : id,
        checked: !actorFilter.types || actorFilter.types.has(id)
      }));
      const menu = document.createElement('div');
      menu.className = 'ssm-actor-filter-menu';
      menu.innerHTML = `
        <label class="ssm-af-row"><input type="checkbox" class="ssm-af-player-owned"${actorFilter.playerOwned ? ' checked' : ''}> ${game.i18n.localize('SANDBOX_SETTLEMENT_MANAGER.actor.playerOwned')}</label>
        <hr class="ssm-af-divider">
        ${types.map(t => `<label class="ssm-af-row"><input type="checkbox" class="ssm-af-type" data-type="${t.id}"${t.checked ? ' checked' : ''}> ${t.label}</label>`).join('')}
      `;
      const rect = btn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top  = `${rect.bottom + 2}px`;
      menu.style.left = `${rect.left}px`;
      document.body.appendChild(menu);
      menu.addEventListener('click', e => e.stopPropagation());
      document.addEventListener('click', () => {
        if (!menu.isConnected) return;
        menu.remove();
        applyFromMenu(menu);
      }, { once: true, signal });
    }, { signal });
  }

  static async #onSubmit(event, form, formData) {
    const sourceActorId = this._sourceActor?.id ?? null;
    if (!sourceActorId) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.noSourceActorWarn"));
      throw new Error("No source actor selected");
    }
    const hiringActorId = this._hiringActor?.id ?? null;
    if (!hiringActorId) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.noActorWarn"));
      throw new Error("No hiring actor selected");
    }
    const contractTerms = ["wages", "treasure", "both"].includes(formData.object.contractTerms) ? formData.object.contractTerms : "wages";
    const wantsWage = contractTerms === "wages" || contractTerms === "both";
    const wageAmount     = wantsWage ? Math.max(0, parseFloat(formData.object.wageAmount) || 0) : 0;
    const wageCurrencyId = wantsWage ? (formData.object.wageCurrencyId ?? "") : "";
    const wagePeriod     = ["day", "week", "month"].includes(formData.object.wagePeriod) ? formData.object.wagePeriod : "week";
    const treasureShare  = (contractTerms === "treasure" || contractTerms === "both")
      ? (TREASURE_SHARES.includes(formData.object.treasureShare) ? formData.object.treasureShare : "1/2")
      : null;
    const mode = formData.object.mode === "link" ? "link" : "clone";

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({ mode, sourceActorId, hiringActorId, contractTerms, wageAmount, wageCurrencyId, wagePeriod, treasureShare });
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#actorWidgetAbort?.abort();
    this.#actorDropdownEls.forEach(el => el.remove());
    this.#actorDropdownEls = [];
    document.querySelector('.ssm-actor-filter-menu')?.remove();
    this._resolve?.(null);
    this._resolve = null;
  }
}
