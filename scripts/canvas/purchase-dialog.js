import { MODULE_ID, SETTINGS } from "../constants.js";
import {
  parseExchangeRate,
  costInStandard,
  totalOfferedInStandard,
  calculateChange,
  formatAmounts,
  readActorBalance,
  settlePayment
} from "../utils/currency-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class PurchaseDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _expense;
  _currencies;
  _mode;
  _actor = null;
  _pendingPayment = null;

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
    const ownedActors = game.actors.filter(a => game.user.isGM ? a.hasPlayerOwner : a.testUserPermission(game.user, "OWNER"));
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
        const maxRate = this._currencies.reduce((m, c) => Math.max(m, parseExchangeRate(c.exchangeRate)), 0);
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
      ownedActors: ownedActors.map(a => ({ value: a.id, label: a.name })),
      selectedActorId: this._actor?.id ?? "",
      balance,
      showBalance: isAttributeOrItem && this._actor !== null
    };
  }

  #readActorBalance(currency) {
    return readActorBalance(this._actor, currency, this._mode);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this.element.querySelector('[name="actorId"]')?.addEventListener("change", async e => {
      this._actor = game.actors.get(e.target.value) ?? null;
      this.render({ parts: ["form"] });
    });

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
    this._resolve?.(null);
    this._resolve = null;
  }
}
