import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only dialog for editing a bank deposit row (which may represent several merged/matured
 * records — see location-data.js `buildDepositDisplayList`). Lets the GM adjust the coin amounts,
 * reassign the deposit to a different actor, and change how many days remain until it matures.
 * None of these edits touch any actor's live currency balance — they only change the stored
 * deposit record(s).
 */
export class DepositEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _row;          // { id, coins, depositedAt, minDepositSeconds, matured }
  _currencies;
  _actors;        // [{ id, name }]
  _secondsPerDay;
  _now;

  constructor(row, { currencies, actors, secondsPerDay, now }, options = {}) {
    super(options);
    this._row           = row;
    this._currencies     = currencies;
    this._actors         = actors;
    this._secondsPerDay = secondsPerDay;
    this._now           = now;
  }

  get title() { return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.editTitle"); }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-deposit-edit`,
    tag: "form",
    form: { handler: DepositEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 360 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/deposit-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Open the dialog. Resolves with { targetIds, updatedDeposit } or null if cancelled. */
  static async open(row, context) {
    return new Promise(resolve => {
      const app = new DepositEditApp(row, context);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const remainingDays = this._row.matured
      ? 0
      : Math.max(0, Math.ceil((this._row.depositedAt + this._row.minDepositSeconds - this._now) / this._secondsPerDay));

    return {
      actors: this._actors.map(a => ({ ...a, selected: a.id === this._row.actorId })),
      currencyRows: this._currencies.map(c => ({
        id: c.id, abbreviation: c.abbreviation, amount: this._row.coins?.[c.id] ?? 0
      })),
      remainingDays,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="actorId"]')?.focus();
  }

  static async #onSubmit(event, form, formData) {
    const actorId   = formData.object.actorId ?? this._row.actorId;
    const actorName = game.actors.get(actorId)?.name ?? this._row.actorName ?? "";

    const coins = {};
    for (const input of form.querySelectorAll('.deposit-edit-coin-input')) {
      const amt = parseInt(input.value) || 0;
      if (amt > 0) coins[input.dataset.currencyId] = amt;
    }

    const remainingDays = Math.max(0, parseInt(formData.object.remainingDays) || 0);

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      targetIds: this._row.targetIds,
      updatedDeposit: {
        id: this._row.id || foundry.utils.randomID(),
        actorId, actorName, coins,
        depositedAt:       this._now,
        minDepositSeconds: remainingDays * this._secondsPerDay
      }
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
