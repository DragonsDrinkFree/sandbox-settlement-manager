import { MODULE_ID } from "../constants.js";
import { getStandardCurrency } from "../utils/currency-utils.js";
import { TREASURE_SHARES, treasureShareOptions } from "../utils/contract-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Player-facing dialog for negotiating a Stable contract. Collects which owned character is hiring
 * (via the same searchable actor-dropdown widget used by LoanOfferApp/PurchaseDialog), a proposed
 * wage (amount + denomination + Daily/Weekly/Monthly) and/or an offered treasure share, depending on
 * the listing's `contractTerms`. Resolves with the offer; the caller emits it to the GM for review.
 */
export class NegotiateContractApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _ctx;
  _actor = null;
  _actorFilter = { playerOwned: true, types: null };
  #actorWidgetAbort = null;
  #actorDropdownEl = null;

  constructor(options = {}) {
    super(options);
    this._actor = game.user.character
      ?? game.actors.find(a => game.user.isGM ? a.hasPlayerOwner : a.testUserPermission(game.user, "OWNER"))
      ?? null;
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-negotiate-contract`,
    tag: "form",
    form: { handler: NegotiateContractApp.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.stable.contract.negotiateTitle" }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/negotiate-contract.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /**
   * @param {{ currencies:Array, contractTerms:"wages"|"treasure"|"both", listingName:string }} ctx
   * @returns {Promise<{ hiringActorId, wageAmount, wageCurrencyId, wagePeriod, treasureShare }|null>}
   */
  static async open(ctx) {
    return new Promise(resolve => {
      const app = new NegotiateContractApp();
      app._ctx = ctx;
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const { currencies, contractTerms, listingName } = this._ctx;
    const std = getStandardCurrency(currencies);

    const actorFilter = (a) => {
      if (!game.user.isGM) return a.testUserPermission(game.user, "OWNER");
      if (this._actorFilter.playerOwned && !a.hasPlayerOwner) return false;
      if (this._actorFilter.types?.size && !this._actorFilter.types.has(a.type)) return false;
      return true;
    };
    const ownedActors = game.actors.filter(actorFilter).map(a => ({ id: a.id, name: a.name }));

    return {
      listingName,
      wantsWage:     contractTerms === "wages" || contractTerms === "both",
      wantsTreasure: contractTerms === "treasure" || contractTerms === "both",
      currencies,
      wagePrice: { amount: 0, currencyId: std?.id ?? currencies[0]?.id ?? "" },
      periods: ["day", "week", "month"].map(u => ({
        id: u,
        label: game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.bank.loans.period.${u}`),
        selected: u === "week"
      })),
      treasureShares: treasureShareOptions("1/2"),
      isGM: game.user.isGM,
      ownedActors,
      selectedActorId: this._actor?.id ?? "",
      selectedActorName: this._actor?.name ?? "",
      filterActive: game.user.isGM && (!this._actorFilter.playerOwned || this._actorFilter.types !== null),
      buttons: [{ type: "submit", icon: "fa-solid fa-file-signature", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.makeOffer") }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#wireActorWidget();
  }

  #wireActorWidget() {
    this.#actorWidgetAbort?.abort();
    this.#actorWidgetAbort = new AbortController();
    const { signal } = this.#actorWidgetAbort;
    this.#actorDropdownEl?.remove();
    this.#actorDropdownEl = null;
    document.querySelector('.ssm-actor-filter-menu')?.remove();

    const widget = this.element.querySelector('.ssm-actor-dropdown-widget');
    if (widget) {
      this.#wireActorDropdown(widget, signal, id => {
        this._actor = game.actors.get(id) ?? null;
        this.render({ parts: ["form"] });
      });
    }
    const filterBtn = this.element.querySelector('.ssm-actor-filter-btn');
    if (filterBtn) {
      this.#wireActorFilterMenu(filterBtn, this._actorFilter, signal, f => {
        this._actorFilter = f;
        this.render({ parts: ["form"] });
      });
    }
  }

  #wireActorDropdown(widget, signal, onSelect) {
    const trigger = widget.querySelector('.ssm-actor-dropdown-trigger');
    const list    = widget.querySelector('.ssm-actor-dropdown-list');
    if (!trigger || !list) return;
    document.body.appendChild(list);
    this.#actorDropdownEl = list;
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
    const hiringActorId = this._actor?.id ?? null;
    if (!hiringActorId) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.noActorWarn"));
      throw new Error("No hiring actor selected");
    }
    const terms = this._ctx.contractTerms;
    const wantsWage = terms === "wages" || terms === "both";
    const wageAmount     = wantsWage ? Math.max(0, parseFloat(formData.object.wageAmount) || 0) : 0;
    const wageCurrencyId = wantsWage ? (formData.object.wageCurrencyId ?? "") : "";
    const wagePeriod     = ["day", "week", "month"].includes(formData.object.wagePeriod) ? formData.object.wagePeriod : "week";
    const treasureShare  = (terms === "treasure" || terms === "both")
      ? (TREASURE_SHARES.includes(formData.object.treasureShare) ? formData.object.treasureShare : "1/2")
      : null;

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({ hiringActorId, wageAmount, wageCurrencyId, wagePeriod, treasureShare });
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#actorWidgetAbort?.abort();
    this.#actorDropdownEl?.remove();
    document.querySelector('.ssm-actor-filter-menu')?.remove();
    this._resolve?.(null);
    this._resolve = null;
  }
}
