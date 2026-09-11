import { MODULE_ID } from "../constants.js";
import { getStandardCurrency } from "../utils/currency-utils.js";
import { TREASURE_SHARES, treasureShareOptions } from "../utils/contract-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Player-facing dialog for negotiating a Stable contract. Collects which owned character is hiring,
 * a proposed wage (amount + denomination + Daily/Weekly/Monthly) and/or an offered treasure share,
 * depending on the listing's `contractTerms`. Resolves with the offer; the caller emits it to the
 * GM for review.
 */
export class NegotiateContractApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _ctx;

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
    const ownedActors = game.actors.filter(a => a.isOwner).map(a => ({ id: a.id, name: a.name }));
    const std = getStandardCurrency(currencies);
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
      ownedActors,
      buttons: [{ type: "submit", icon: "fa-solid fa-file-signature", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.makeOffer") }]
    };
  }

  static async #onSubmit(event, form, formData) {
    const hiringActorId = formData.object.hiringActorId;
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
    this._resolve?.(null);
    this._resolve = null;
  }
}
