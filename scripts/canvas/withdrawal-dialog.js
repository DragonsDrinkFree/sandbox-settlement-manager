import { MODULE_ID } from "../constants.js";
import { parseExchangeRate, totalOfferedInStandard, calculateChange, formatAmounts, getMaxDenomValue } from "../utils/currency-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class WithdrawalDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve  = null;
  _deposit  = null;   // { id, coins, depositedAt, minDepositSeconds } or merged group
  _depositSettings = null;
  _currencies = [];
  _worldTime  = 0;

  constructor(deposit, depositSettings, currencies, worldTime, options = {}) {
    super(options);
    this._deposit         = deposit;
    this._depositSettings = depositSettings;
    this._currencies      = currencies;
    this._worldTime       = worldTime;
  }

  get title() { return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.withdrawTitle"); }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-withdrawal-dialog`,
    tag: "form",
    form: { handler: WithdrawalDialog.#onSubmit, closeOnSubmit: true },
    position: { width: 380 },
    actions: {}
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/canvas/withdrawal-dialog.hbs` }
  };

  /** Open the dialog. Resolves with { withdrawCoins } or null if cancelled. */
  static async open({ deposit, depositSettings, currencies, worldTime }) {
    return new Promise(resolve => {
      const app = new WithdrawalDialog(deposit, depositSettings, currencies, worldTime);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const isEarly = this._worldTime < this._deposit.depositedAt + this._deposit.minDepositSeconds;
    const earlyFeeRate = isEarly ? (this._depositSettings.earlyWithdrawalFee ?? 0) : 0;

    const coinRows = this._currencies
      .map(c => ({
        id:           c.id,
        abbreviation: c.abbreviation,
        maxAmount:    this._deposit.coins[c.id] ?? 0
      }))
      .filter(r => r.maxAmount > 0);

    return {
      ...context,
      deposit:      this._deposit,
      coinRows,
      isEarly,
      earlyFeeRate,
      buttons: [
        { type: "submit", icon: "fa-solid fa-vault", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.withdrawButton") },
        { type: "button", icon: "fa-solid fa-times",  label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.cancelButton"),
          action: "close" }
      ]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#wirePreview();
  }

  /**
   * Read the amount inputs, clamping each to what the deposit actually holds. The `max` attribute
   * alone doesn't bind — a typed-in overage would otherwise be submitted verbatim and, before the
   * server-side clamp, paid out in full. Clamped values are written back so the displayed number,
   * the preview, and the submitted amount always agree.
   */
  #readWithdrawCoins(form) {
    const withdrawCoins = {};
    for (const input of form.querySelectorAll('.ssm-withdraw-amount-input')) {
      const cId       = input.dataset.currencyId;
      const available = this._deposit.coins?.[cId] ?? 0;
      const raw       = Math.max(0, Math.floor(parseInt(input.value) || 0));
      const amt       = Math.min(raw, available);
      if (amt !== raw) input.value = amt;
      if (amt > 0) withdrawCoins[cId] = amt;
    }
    return withdrawCoins;
  }

  #wirePreview() {
    const form       = this.element;
    const feeEl      = form.querySelector('.ssm-withdraw-fee-preview');
    const receiveEl  = form.querySelector('.ssm-withdraw-receive-preview');
    const submitBtn  = form.querySelector('[type="submit"]');
    const earlyFeeRate = this._depositSettings.earlyWithdrawalFee ?? 0;
    const isEarly    = this._worldTime < this._deposit.depositedAt + this._deposit.minDepositSeconds;
    const currencies = this._currencies;

    const update = () => {
      const withdrawCoins = this.#readWithdrawCoins(form);
      const hasAny = Object.keys(withdrawCoins).length > 0;
      if (submitBtn) submitBtn.disabled = !hasAny;

      if (!hasAny) {
        if (feeEl)     feeEl.textContent     = '';
        if (receiveEl) receiveEl.textContent = '';
        return;
      }

      if (isEarly && earlyFeeRate > 0) {
        const totalStd  = totalOfferedInStandard(withdrawCoins, currencies);
        const feeStd    = totalStd * earlyFeeRate / 100;
        const payoutStd = Math.max(0, totalStd - feeStd);
        // Cap to the highest-value coin actually being withdrawn, so the preview never shows a
        // larger/unrelated denomination (e.g. GP becoming PP) the player never handled — matches
        // the server-side payout calculation in socket.js `_handleProcessWithdrawal`.
        const withdrawnRates = Object.keys(withdrawCoins)
          .map(cId => parseExchangeRate(currencies.find(c => c.id === cId)?.exchangeRate));
        const maxDenom  = withdrawnRates.length ? Math.max(...withdrawnRates) : getMaxDenomValue(currencies);
        const feeCoins  = calculateChange(feeStd, currencies, maxDenom) ?? {};
        const payCoins  = calculateChange(payoutStd, currencies, maxDenom) ?? {};
        if (feeEl)     feeEl.textContent     = formatAmounts(feeCoins, currencies);
        if (receiveEl) receiveEl.textContent = formatAmounts(payCoins, currencies);
      } else {
        if (feeEl)     feeEl.textContent     = '';
        if (receiveEl) receiveEl.textContent = formatAmounts(withdrawCoins, currencies);
      }
    };

    form.querySelectorAll('.ssm-withdraw-amount-input').forEach(input => {
      input.addEventListener('input', update);
    });
    if (submitBtn) submitBtn.disabled = true;
    update();
  }

  async _onClose(options) {
    await super._onClose(options);
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(null);
  }

  static async #onSubmit(event, form, formData) {
    const withdrawCoins = this.#readWithdrawCoins(form);
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(Object.keys(withdrawCoins).length > 0 ? { withdrawCoins } : null);
  }
}
