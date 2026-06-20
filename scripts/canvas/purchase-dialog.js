import { MODULE_ID, SETTINGS } from "../constants.js";
import {
  parseExchangeRate,
  costInStandard,
  totalOfferedInStandard,
  calculateChange,
  formatAmounts,
  readActorBalance,
  settlePayment,
  getStandardCurrency,
  getMaxDenomValue
} from "../utils/currency-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class PurchaseDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _expense;
  _currencies;
  _mode;
  _actor = null;
  _pendingPayment = null;
  _actorFilter = { playerOwned: true, types: null };
  #actorWidgetAbort = null;
  #actorDropdownEl = null;

  constructor(expense, currencies, mode, options = {}) {
    super(options);
    this._expense = expense;
    this._currencies = currencies;
    this._mode = mode;
    this._actor = game.user.character
      ?? game.actors.find(a => game.user.isGM ? a.hasPlayerOwner : a.testUserPermission(game.user, "OWNER"))
      ?? null;
  }

  get title() { return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.purchase.title"); }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-purchase-dialog`,
    tag: "form",
    form: { handler: PurchaseDialog.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    actions: { fillCurrency: PurchaseDialog.#onFillCurrency }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/canvas/purchase-dialog.hbs` }
  };

  static async open({ expense, currencies, mode }) {
    return new Promise(resolve => {
      const app = new PurchaseDialog(expense, currencies, mode);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const isAttributeOrItem = this._mode !== "loose";
    const actorFilter = (a) => {
      if (!game.user.isGM) return a.testUserPermission(game.user, "OWNER");
      if (this._actorFilter.playerOwned && !a.hasPlayerOwner) return false;
      if (this._actorFilter.types?.size && !this._actorFilter.types.has(a.type)) return false;
      return true;
    };
    const ownedActors = game.actors.filter(actorFilter).map(a => ({ id: a.id, name: a.name }));
    const costCurrency = this._currencies.find(c => c.id === this._expense.currencyId);
    const balance = {};
    if (this._actor && isAttributeOrItem) {
      for (const c of this._currencies) {
        balance[c.id] = this.#readActorBalance(c);
      }
    }
    return {
      ...context,
      expense: this._expense,
      expenseCostLabel: (() => {
        const totalStd = costInStandard(this._expense, this._currencies);
        const standardCurrency = getStandardCurrency(this._currencies);
        const stdRate = standardCurrency ? parseExchangeRate(standardCurrency.exchangeRate) : 0;
        const maxRate = stdRate > 1e-9 ? stdRate : getMaxDenomValue(this._currencies);
        const breakdown = calculateChange(totalStd, this._currencies, maxRate);
        return (breakdown && Object.values(breakdown).some(v => v > 0))
          ? formatAmounts(breakdown, this._currencies)
          : `${this._expense.amount} ${costCurrency?.abbreviation ?? "?"}`;
      })(),
      currencies: this._currencies.map(c => ({
        ...c,
        fillDisabled: isAttributeOrItem && (balance[c.id] ?? 0) === 0
      })),
      mode: this._mode,
      isLoose: this._mode === "loose",
      isAttributeOrItem,
      isGM: game.user.isGM,
      ownedActors,
      selectedActorId: this._actor?.id ?? "",
      selectedActorName: this._actor?.name ?? "",
      filterActive: game.user.isGM && (!this._actorFilter.playerOwned || this._actorFilter.types !== null),
      balance,
      showBalance: isAttributeOrItem && this._actor !== null
    };
  }

  #readActorBalance(currency) {
    return readActorBalance(this._actor, currency, this._mode);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this.#wireActorWidget();

    this.element.querySelectorAll(".payment-input").forEach(input => {
      input.addEventListener("input", () => this.#updateLiveCalc());
    });

    this.#updateLiveCalc();
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
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelector('.ssm-actor-filter-menu')?.remove();
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
      menu.addEventListener('change', () => {
        const playerOwned  = menu.querySelector('.ssm-af-player-owned')?.checked ?? true;
        const typeCbs      = [...menu.querySelectorAll('.ssm-af-type')];
        const allChecked   = typeCbs.every(cb => cb.checked);
        const checkedTypes = typeCbs.filter(cb => cb.checked).map(cb => cb.dataset.type);
        onApply({ playerOwned, types: allChecked ? null : (checkedTypes.length ? new Set(checkedTypes) : null) });
      });
      document.addEventListener('click', () => menu.remove(), { once: true, signal });
    }, { signal });
  }

  #getPaymentAmounts() {
    const amounts = {};
    this.element.querySelectorAll(".payment-input").forEach(input => {
      amounts[input.dataset.currencyId] = Math.max(0, parseInt(input.value) || 0);
    });
    return amounts;
  }

  static #onFillCurrency(event, target) {
    const currencyId = target.dataset.currencyId;
    const currency = this._currencies.find(c => c.id === currencyId);
    if (!currency) return;
    const rate = parseExchangeRate(currency.exchangeRate);
    if (rate < 1e-9) return;

    const payment = this.#getPaymentAmounts();
    const cost = costInStandard(this._expense, this._currencies);
    const offered = totalOfferedInStandard(payment, this._currencies);
    const remaining = Math.max(0, cost - offered);
    if (remaining < 1e-9) return;

    const input = this.element.querySelector(`.payment-input[data-currency-id="${currencyId}"]`);
    if (!input) return;

    const currentInInput = Math.max(0, parseInt(input.value) || 0);
    let coinsToAdd = Math.ceil(remaining / rate - 1e-9);

    if (this._mode !== "loose" && this._actor) {
      const balance = this.#readActorBalance(currency);
      const maxAddable = Math.max(0, balance - currentInInput);
      coinsToAdd = Math.min(coinsToAdd, maxAddable);
    }

    if (coinsToAdd <= 0) return;
    input.value = currentInInput + coinsToAdd;
    this.#updateLiveCalc();
  }

  #updateLiveCalc() {
    const payment = this.#getPaymentAmounts();
    const cost = costInStandard(this._expense, this._currencies);
    const offered = totalOfferedInStandard(payment, this._currencies);
    const excess = offered - cost;
    const remainingStd = Math.max(0, cost - offered);

    const offerEl     = this.element.querySelector(".calc-offering");
    const changeEl    = this.element.querySelector(".calc-change");
    const remainingEl = this.element.querySelector(".calc-remaining");
    const errorEl     = this.element.querySelector(".purchase-error");
    const submitBtn   = this.element.querySelector('[type="submit"]');

    if (offerEl) offerEl.textContent = formatAmounts(payment, this._currencies);

    if (remainingEl) {
      if (offered < 1e-9 || remainingStd < 1e-9) {
        remainingEl.textContent = "—";
      } else {
        const maxRate = Math.max(...this._currencies.map(c => parseExchangeRate(c.exchangeRate)));
        const breakdown = calculateChange(remainingStd, this._currencies, maxRate);
        remainingEl.textContent = breakdown ? formatAmounts(breakdown, this._currencies) : `${remainingStd}`;
      }
    }

    const setError = (key) => {
      if (errorEl) errorEl.textContent = game.i18n.localize(key);
      if (changeEl) changeEl.textContent = "—";
      if (submitBtn) submitBtn.disabled = true;
      this._pendingPayment = null;
    };

    const usedCurrencies = this._currencies.filter(c => (payment[c.id] ?? 0) > 0);

    if (usedCurrencies.length === 0 || offered < 1e-9) {
      setError("SANDBOX_SETTLEMENT_MANAGER.purchase.error.underpay");
      if (errorEl && offered < 1e-9) errorEl.textContent = "";
      return;
    }

    if (excess < -1e-9) {
      setError("SANDBOX_SETTLEMENT_MANAGER.purchase.error.underpay");
      return;
    }

    const maxPayValue = Math.max(...usedCurrencies.map(c => parseExchangeRate(c.exchangeRate)));
    const change = calculateChange(excess, this._currencies, maxPayValue);

    if (change === null) {
      setError("SANDBOX_SETTLEMENT_MANAGER.purchase.error.cannotMakeChange");
      return;
    }

    const changeStr = Object.values(change).some(v => v > 0)
      ? formatAmounts(change, this._currencies)
      : game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.purchase.noChange");

    if (changeEl) changeEl.textContent = changeStr;
    if (errorEl) errorEl.textContent = "";
    if (submitBtn) submitBtn.disabled = false;
    this._pendingPayment = { payment, change };
  }

  static async #onSubmit() {
    if (!this._pendingPayment) return;
    const { payment, change } = this._pendingPayment;

    // Re-validate funds before committing (balance could have changed)
    if (this._mode !== "loose" && this._actor) {
      for (const [currencyId, coins] of Object.entries(payment)) {
        if (coins <= 0) continue;
        const c = this._currencies.find(x => x.id === currencyId);
        if (!c) continue;
        const balance = this.#readActorBalance(c);
        if (balance < coins) {
          ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.purchase.error.insufficientFunds"));
          return;
        }
      }
    }

    try {
      if (this._mode === "loose") {
        await this.#executeLooseTransaction(payment, change);
      } else {
        await settlePayment(this._actor, { payment, change }, this._currencies, this._mode);
      }
    } catch (err) {
      // Transaction aborted (e.g. last-moment insufficient funds guard)
      return;
    }

    ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.purchase.complete"));
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({ actorId: this._actor?.id ?? null });
  }

  async #executeLooseTransaction(payment, change) {
    const costCurrency = this._currencies.find(c => c.id === this._expense.currencyId);
    const costStr = `${this._expense.amount} ${costCurrency?.abbreviation ?? "?"}`;
    const content = game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.purchase.whisperContent", {
      expense: this._expense.name,
      cost: costStr,
      payment: formatAmounts(payment, this._currencies),
      change: formatAmounts(change, this._currencies)
    });
    await ChatMessage.create({
      content,
      whisper: [
        game.user.id,
        ...game.users.filter(u => u.isGM && u.active && u.id !== game.user.id).map(u => u.id)
      ]
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
