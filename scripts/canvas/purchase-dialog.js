import { MODULE_ID, SETTINGS } from "../constants.js";
import {
  parseExchangeRate,
  costInStandard,
  totalOfferedInStandard,
  calculateChange,
  formatAmounts
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
      ?? game.actors.find(a => a.testUserPermission(game.user, "OWNER"))
      ?? null;
  }

  get title() { return game.i18n.localize("SANDBOX_CITY_MANAGER.purchase.title"); }

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
    const ownedActors = game.actors.filter(a => a.testUserPermission(game.user, "OWNER"));
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
      expenseCostLabel: `${this._expense.amount} ${costCurrency?.abbreviation ?? "?"}`,
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
    if (!this._actor) return 0;
    if (this._mode === "attribute" && currency.attributePath) {
      return foundry.utils.getProperty(this._actor, currency.attributePath) ?? 0;
    }
    if (this._mode === "item" && currency.itemName) {
      const item = this._actor.items.find(i => i.name === currency.itemName);
      return foundry.utils.getProperty(item ?? {}, "system.quantity") ?? 0;
    }
    return 0;
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
    if (remaining < 1e-9) return; // already paid

    // Minimum whole coins of this denomination to cover the remaining gap
    const coinsToAdd = Math.ceil(remaining / rate - 1e-9);

    const input = this.element.querySelector(`.payment-input[data-currency-id="${currencyId}"]`);
    if (!input) return;
    input.value = (Math.max(0, parseInt(input.value) || 0)) + coinsToAdd;
    this.#updateLiveCalc();
  }

  #updateLiveCalc() {
    const payment = this.#getPaymentAmounts();
    const cost = costInStandard(this._expense, this._currencies);
    const offered = totalOfferedInStandard(payment, this._currencies);
    const excess = offered - cost;

    const offerEl  = this.element.querySelector(".calc-offering");
    const changeEl = this.element.querySelector(".calc-change");
    const errorEl  = this.element.querySelector(".purchase-error");
    const submitBtn = this.element.querySelector('[type="submit"]');

    if (offerEl) offerEl.textContent = formatAmounts(payment, this._currencies);

    const setError = (key) => {
      if (errorEl) errorEl.textContent = game.i18n.localize(key);
      if (changeEl) changeEl.textContent = "—";
      if (submitBtn) submitBtn.disabled = true;
      this._pendingPayment = null;
    };

    const usedCurrencies = this._currencies.filter(c => (payment[c.id] ?? 0) > 0);

    if (usedCurrencies.length === 0 || offered < 1e-9) {
      setError("SANDBOX_CITY_MANAGER.purchase.error.underpay");
      if (errorEl && offered < 1e-9) errorEl.textContent = "";
      return;
    }

    if (excess < -1e-9) {
      setError("SANDBOX_CITY_MANAGER.purchase.error.underpay");
      return;
    }

    const maxPayValue = Math.max(...usedCurrencies.map(c => parseExchangeRate(c.exchangeRate)));
    const change = calculateChange(excess, this._currencies, maxPayValue);

    if (change === null) {
      setError("SANDBOX_CITY_MANAGER.purchase.error.cannotMakeChange");
      return;
    }

    const changeStr = Object.values(change).some(v => v > 0)
      ? formatAmounts(change, this._currencies)
      : game.i18n.localize("SANDBOX_CITY_MANAGER.purchase.noChange");

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
          ui.notifications.warn(game.i18n.localize("SANDBOX_CITY_MANAGER.purchase.error.insufficientFunds"));
          return;
        }
      }
    }

    try {
      if (this._mode === "attribute") {
        await this.#executeAttributeTransaction(payment, change);
      } else if (this._mode === "item") {
        await this.#executeItemTransaction(payment, change);
      } else {
        await this.#executeLooseTransaction(payment, change);
      }
    } catch (err) {
      // Transaction aborted (e.g. last-moment insufficient funds guard)
      return;
    }

    ui.notifications.info(game.i18n.localize("SANDBOX_CITY_MANAGER.purchase.complete"));
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(true);
  }

  async #executeAttributeTransaction(payment, change) {
    const updates = {};
    const collect = (currencyId, delta) => {
      const c = this._currencies.find(x => x.id === currencyId);
      if (!c?.attributePath) return;
      const current = updates[c.attributePath] ?? foundry.utils.getProperty(this._actor, c.attributePath) ?? 0;
      updates[c.attributePath] = current + delta;
    };
    for (const [id, coins] of Object.entries(payment)) if (coins > 0) collect(id, -coins);
    for (const [id, coins] of Object.entries(change)) if (coins > 0) collect(id, coins);
    if (Object.keys(updates).length) await this._actor.update(updates);
  }

  async #executeItemTransaction(payment, change) {
    for (const [id, coins] of Object.entries(payment)) if (coins > 0) await this.#applyItemDelta(id, -coins);
    for (const [id, coins] of Object.entries(change)) if (coins > 0) await this.#applyItemDelta(id, coins);
  }

  async #applyItemDelta(currencyId, delta) {
    const c = this._currencies.find(x => x.id === currencyId);
    if (!c) return;
    const existing = this._actor.items.find(i => i.name === c.itemName);

    if (existing) {
      const qty = foundry.utils.getProperty(existing, "system.quantity") ?? 0;
      // Guard: never allow negative quantity when paying
      if (delta < 0 && qty + delta < 0) {
        ui.notifications.warn(`${game.i18n.localize("SANDBOX_CITY_MANAGER.purchase.error.insufficientFunds")}: ${c.name}`);
        throw new Error("Insufficient item quantity");
      }
      await existing.update({ "system.quantity": qty + delta });
      return;
    }

    // Item not on actor — only relevant when giving change (delta > 0)
    if (delta <= 0) return;
    const source = game.items.find(i => i.name === c.itemName)
      ?? (c.itemId ? await fromUuid(c.itemId).catch(() => null) : null);
    if (source) {
      const data = source.toObject();
      foundry.utils.setProperty(data, "system.quantity", delta);
      await this._actor.createEmbeddedDocuments("Item", [data]);
    } else {
      ui.notifications.warn(`Cannot give change: no world item found for "${c.itemName}"`);
    }
  }

  async #executeLooseTransaction(payment, change) {
    const costCurrency = this._currencies.find(c => c.id === this._expense.currencyId);
    const costStr = `${this._expense.amount} ${costCurrency?.abbreviation ?? "?"}`;
    const content = game.i18n.format("SANDBOX_CITY_MANAGER.purchase.whisperContent", {
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
