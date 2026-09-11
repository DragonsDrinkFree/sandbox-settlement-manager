import { MODULE_ID, FLAGS } from "../constants.js";
import { getCurrencyContext, formatAmounts } from "../utils/currency-utils.js";
import { secondsToComponents } from "../time/world-time.js";
import { accrueContract, contractOwedCoins, contractTermsLabel, treasureShareLabel } from "../utils/contract-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Read-only window showing a hired actor's contract terms (wage rate, treasure share, when it
 * started / was last paid, wage owed so far). GMs also get an editable notes field. Opened from the
 * actor sheet's contract button (contract-sheet-button.js) and from the Contract Manager.
 */
export class ContractDetailsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _actor;
  _updateHook = null;
  _timeHook = null;

  constructor(actor, options = {}) {
    super(options);
    this._actor = actor;
  }

  get title() {
    return game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.stable.contract.detailsTitle", { name: this._actor?.name ?? "" });
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-contract-details`,
    window: { resizable: true },
    position: { width: 460 }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/canvas/contract-details.hbs` }
  };

  static open(actor) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-contract-details`);
    if (existing) existing.close();
    new ContractDetailsApp(actor).render(true);
  }

  async _prepareContext(options) {
    const c = this._actor.getFlag(MODULE_ID, FLAGS.CONTRACT);
    if (!c) return { missing: true };

    const { currencies } = getCurrencyContext();
    const now = game.time.worldTime;
    const isWage = c.contractTerms === "wages" || c.contractTerms === "both";
    const isTreasure = c.contractTerms === "treasure" || c.contractTerms === "both";
    const accrued = accrueContract(c, now);
    const periodLabel = game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.bank.loans.period.${c.wagePeriod ?? "week"}`);
    const ago = (t) => {
      const { totalDays, hour, minute } = secondsToComponents(Math.max(0, now - (t ?? now)));
      return game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.stable.contract.agoLabel", {
        d: totalDays, h: hour, m: String(minute).padStart(2, "0")
      });
    };

    return {
      isGM: game.user.isGM,
      termsLabel: contractTermsLabel(c.contractTerms),
      isWage, isTreasure,
      wageRateLabel: isWage ? game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.stable.contract.wageRate", {
        amount: formatAmounts(c.wageCoins ?? {}, currencies), period: periodLabel
      }) : null,
      treasureShareLabel: isTreasure ? treasureShareLabel(c.treasureShare) : null,
      sourceActorName: c.sourceActorName,
      hiringActorName: c.hiringActorName,
      locationName: c.locationName ?? "",
      initiatedLabel: ago(c.initiatedAt),
      lastPaidLabel: ago(c.lastPaidAt),
      owedLabel: isWage ? formatAmounts(contractOwedCoins(accrued.owedStandard, currencies), currencies) : null,
      gmNotes: c.gmNotes ?? ""
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    if (game.user.isGM) {
      const ta = this.element.querySelector('textarea[name="gmNotes"]');
      if (ta) {
        const save = async () => {
          const cur = this._actor.getFlag(MODULE_ID, FLAGS.CONTRACT);
          if (cur && ta.value !== (cur.gmNotes ?? "")) {
            await this._actor.setFlag(MODULE_ID, FLAGS.CONTRACT, { ...cur, gmNotes: ta.value });
          }
        };
        ta.addEventListener("change", save);
        ta.addEventListener("blur", save);
      }
    }

    if (!this._updateHook) {
      this._updateHook = Hooks.on("updateActor", (a) => { if (a.id === this._actor.id) this.render(); });
    }
    if (!this._timeHook) {
      const debounced = foundry.utils.debounce(() => this.render(), 250);
      this._timeHook = Hooks.on("updateWorldTime", () => debounced());
    }
  }

  async _onClose(options) {
    await super._onClose(options);
    if (this._updateHook) { Hooks.off("updateActor", this._updateHook); this._updateHook = null; }
    if (this._timeHook) { Hooks.off("updateWorldTime", this._timeHook); this._timeHook = null; }
  }
}
