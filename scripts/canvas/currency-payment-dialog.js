import { MODULE_ID } from "../constants.js";
import {
  parseExchangeRate,
  costInStandard,
  totalOfferedInStandard,
  calculateChange,
  formatAmounts,
  readActorBalance,
  getStandardCurrency,
  getMaxDenomValue
} from "../utils/currency-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Lean currency-input dialog for a single known actor paying a single known fee, with the same
 * live remaining/change calculation and per-currency "fill remaining" button as PurchaseDialog
 * (see purchase-dialog.js) — but without its actor-picker/receiving-actor sections, since the
 * payer here is already fixed by the caller. Resolves { payment, change } for the caller to apply
 * via settlePayment, or null if cancelled.
 */
export class CurrencyPaymentDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _actor;
  _expense;
  _currencies;
  _mode;
  _title;
  _submitLabel;
  _pendingPayment = null;

  constructor(actor, expense, currencies, mode, { title, submitLabel } = {}, options = {}) {
    super(options);
    this._actor       = actor;
    this._expense      = expense;
    this._currencies   = currencies;
    this._mode         = mode;
    this._title        = title;
    this._submitLabel  = submitLabel;
  }

  get title() { return this._title || game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.purchase.confirm"); }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-currency-payment-dialog`,
    tag: "form",
    form: { handler: CurrencyPaymentDialog.#onSubmit, closeOnSubmit: true },
    position: { width: 360 },
    actions: { fillCurrency: CurrencyPaymentDialog.#onFillCurrency }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/canvas/currency-payment-dialog.hbs` }
  };

  /** Open the dialog. Resolves { payment, change } (coin maps) or null if cancelled. */
  static async open({ actor, expense, currencies, mode, title, submitLabel }) {
    return new Promise(resolve => {
      const app = new CurrencyPaymentDialog(actor, expense, currencies, mode, { title, submitLabel });
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const isAttributeOrItem = this._mode !== "loose";
    const costCurrency = this._currencies.find(c => c.id === this._expense.currencyId);
    const balance = {};
    if (isAttributeOrItem) {
      for (const c of this._currencies) balance[c.id] = this.#readActorBalance(c);
    }
    return {
      ...context,
      submitLabel: this._submitLabel || game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.purchase.confirm"),
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
      isLoose: this._mode === "loose",
      isAttributeOrItem,
      balance,
      showBalance: isAttributeOrItem
    };
  }

  #readActorBalance(currency) {
    return readActorBalance(this._actor, currency, this._mode);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelectorAll(".payment-input").forEach(input => {
      input.addEventListener("input", () => this.#updateLiveCalc());
    });
    this.#updateLiveCalc();
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

    if (this._mode !== "loose") {
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
    const changeEl     = this.element.querySelector(".calc-change");
    const remainingEl  = this.element.querySelector(".calc-remaining");
    const errorEl      = this.element.querySelector(".purchase-error");
    const submitBtn    = this.element.querySelector('[type="submit"]');

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

    if (this._mode !== "loose") {
      for (const [currencyId, coins] of Object.entries(payment)) {
        if (coins <= 0) continue;
        const c = this._currencies.find(x => x.id === currencyId);
        if (!c) continue;
        if (this.#readActorBalance(c) < coins) {
          ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.purchase.error.insufficientFunds"));
          return;
        }
      }
    }

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({ payment, change });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
