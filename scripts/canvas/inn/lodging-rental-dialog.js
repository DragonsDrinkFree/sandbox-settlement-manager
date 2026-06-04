import { MODULE_ID } from "../../constants.js";
import { getWorldTimeConfig } from "../../time/world-time.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class LodgingRentalDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _lodging;
  _currencies;

  constructor(lodging, currencies, options = {}) {
    super(options);
    this._lodging = lodging;
    this._currencies = currencies;
  }

  get title() { return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.rental.title"); }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-lodging-rental`,
    tag: "form",
    form: { handler: LodgingRentalDialog.#onSubmit, closeOnSubmit: true },
    position: { width: 340 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/inn/lodging-rental.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(lodging, currencies = []) {
    return new Promise(resolve => {
      const app = new LodgingRentalDialog(lodging, currencies);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const ownedActors = game.actors.filter(a => a.testUserPermission(game.user, "OWNER"));
    const defaultActor = game.user.character ?? ownedActors[0] ?? null;
    const { daysPerWeek } = getWorldTimeConfig();
    const weeklyAmount = this._lodging.pricePerWeek?.amount
      ?? ((this._lodging.pricePerDay?.amount ?? 0) * daysPerWeek);
    const dayCurr = this._currencies.find(c => c.id === this._lodging.pricePerDay?.currencyId);
    return {
      lodging: this._lodging,
      ownedActors: ownedActors.map(a => ({ id: a.id, name: a.name })),
      defaultActorId: defaultActor?.id ?? "",
      currencyAbbr: dayCurr?.abbreviation ?? "?",
      pricePerDayAmount: this._lodging.pricePerDay?.amount ?? 0,
      weeklyAmount,
      buttons: [{ type: "submit", icon: "fa-solid fa-coins", label: "Proceed to Payment" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#wireCostPreview();
  }

  #wireCostPreview() {
    const durationInput = this.element.querySelector('[name="duration"]');
    const costDisplay  = this.element.querySelector('.rental-cost-preview');
    if (!durationInput || !costDisplay) return;

    const { daysPerWeek } = getWorldTimeConfig();
    const update = () => {
      const duration = Math.max(1, parseInt(durationInput.value) || 1);
      const unit = this.element.querySelector('input[name="unit"]:checked')?.value ?? "days";
      const weeklyAmt = this._lodging.pricePerWeek?.amount
        ?? ((this._lodging.pricePerDay?.amount ?? 0) * daysPerWeek);
      const amount = unit === "days"
        ? duration * (this._lodging.pricePerDay?.amount ?? 0)
        : duration * weeklyAmt;
      const abbr = this._currencies.find(c => c.id === this._lodging.pricePerDay?.currencyId)?.abbreviation ?? "?";
      costDisplay.textContent = `${amount} ${abbr}`;
    };

    durationInput.addEventListener("input", update);
    this.element.querySelectorAll('input[name="unit"]').forEach(r => r.addEventListener("change", update));
    update();
  }

  static async #onSubmit(event, form, formData) {
    const actorId  = formData.object.actorId ?? "";
    const actor    = game.actors.get(actorId);
    const duration = Math.max(1, parseInt(formData.object.duration) || 1);
    const unit     = formData.object.unit ?? "days";
    const { hoursPerDay, daysPerWeek } = getWorldTimeConfig();
    const secondsPerDay   = 3600 * hoursPerDay;
    const durationDays    = unit === "days" ? duration : duration * daysPerWeek;
    const durationSeconds = durationDays * secondsPerDay;
    const weeklyAmt = this._lodging.pricePerWeek?.amount
      ?? ((this._lodging.pricePerDay?.amount ?? 0) * daysPerWeek);
    const totalAmount = unit === "days"
      ? duration * (this._lodging.pricePerDay?.amount ?? 0)
      : duration * weeklyAmt;
    const unitLabel = unit === "days"
      ? (duration === 1 ? "day" : "days")
      : (duration === 1 ? "week" : "weeks");
    const expense = {
      id: foundry.utils.randomID(),
      name: `${this._lodging.name} (${duration} ${unitLabel})`,
      currencyId: this._lodging.pricePerDay?.currencyId ?? "",
      amount: totalAmount
    };
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      actorId,
      actorName: actor?.name ?? "Unknown",
      durationSeconds,
      expense
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
