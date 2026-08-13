import { MODULE_ID } from "../constants.js";
import { getStandardCurrency } from "../utils/currency-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only dialog for creating (or editing) a bank loan offer. Collects the target character
 * (via the shared self-contained actor picker), the loan amount + denomination, the interest
 * rate, and the interest period. Resolves with the offer terms; the caller builds the stored
 * loan record and persists it.
 */
export class LoanOfferApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _currencies;
  _loan;                     // existing loan for edit mode, else null
  _actor = null;
  _actorFilter = { playerOwned: true, types: null };
  #actorWidgetAbort = null;
  #actorDropdownEl = null;

  constructor({ currencies, defaultActorId = null, loan = null }, options = {}) {
    super(options);
    this._currencies = currencies;
    this._loan = loan;
    const startId = loan?.actorId ?? defaultActorId;
    this._actor = (startId ? game.actors.get(startId) : null)
      ?? game.user.character
      ?? game.actors.find(a => game.user.isGM ? a.hasPlayerOwner : a.testUserPermission(game.user, "OWNER"))
      ?? null;
  }

  get title() {
    return game.i18n.localize(this._loan
      ? "SANDBOX_SETTLEMENT_MANAGER.bank.loans.editTitle"
      : "SANDBOX_SETTLEMENT_MANAGER.bank.loans.createTitle");
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-loan-offer`,
    tag: "form",
    form: { handler: LoanOfferApp.#onSubmit, closeOnSubmit: true },
    position: { width: 400 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/loan-offer.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Open the dialog. Resolves { actorId, actorName, principalCoins, interestRate, periodUnit } or null. */
  static async open(context) {
    return new Promise(resolve => {
      const app = new LoanOfferApp(context);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const actorFilter = (a) => {
      if (!game.user.isGM) return a.testUserPermission(game.user, "OWNER");
      if (this._actorFilter.playerOwned && !a.hasPlayerOwner) return false;
      if (this._actorFilter.types?.size && !this._actorFilter.types.has(a.type)) return false;
      return true;
    };
    const ownedActors = game.actors.filter(actorFilter).map(a => ({ id: a.id, name: a.name }));

    // Prefill amount/denomination from an existing loan's principal (single denomination) or defaults.
    const std = getStandardCurrency(this._currencies);
    let price = { amount: 0, currencyId: std?.id ?? this._currencies[0]?.id ?? "" };
    if (this._loan?.principalCoins) {
      const [cId, amt] = Object.entries(this._loan.principalCoins)[0] ?? [];
      if (cId != null) price = { amount: amt, currencyId: cId };
    }

    const periods = ["day", "week", "month"].map(u => ({
      id: u,
      label: game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.bank.loans.period.${u}`),
      selected: (this._loan?.periodUnit ?? "week") === u
    }));

    return {
      currencies: this._currencies,
      price,
      interestRate: this._loan?.interestRate ?? 10,
      periods,
      isGM: game.user.isGM,
      ownedActors,
      selectedActorId: this._actor?.id ?? "",
      selectedActorName: this._actor?.name ?? "",
      filterActive: game.user.isGM && (!this._actorFilter.playerOwned || this._actorFilter.types !== null),
      buttons: [{ type: "submit", icon: "fa-solid fa-hand-holding-dollar", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.createSubmit") }]
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
    const actorId = this._actor?.id ?? null;
    if (!actorId) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.noActorWarn"));
      throw new Error("No actor selected");
    }
    const amount     = Math.max(0, parseFloat(formData.object.principalAmount) || 0);
    const currencyId = formData.object.principalCurrencyId;
    if (amount <= 0 || !currencyId) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.noAmountWarn"));
      throw new Error("No amount");
    }
    const interestRate = Math.max(0, parseFloat(formData.object.interestRate) || 0);
    const periodUnit   = ["day", "week", "month"].includes(formData.object.periodUnit) ? formData.object.periodUnit : "week";

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      actorId,
      actorName:      game.actors.get(actorId)?.name ?? "",
      principalCoins: { [currencyId]: amount },
      interestRate,
      periodUnit
    });
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
