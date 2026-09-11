import { MODULE_ID, FLAGS } from "../constants.js";
import { getCurrencyContext, formatAmounts } from "../utils/currency-utils.js";
import { accrueContract, contractOwedCoins, contractTermsLabel, treasureShareLabel } from "../utils/contract-utils.js";
import { ContractDetailsApp } from "./contract-details-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only window listing every active Stable contract: which actor it applies to, who is hiring,
 * the terms, and the wage owed so far (accrued on-read). "Request Payment" is a stub. "Revoke"
 * terminates player ownership of the hired actor and lets the GM either delete it or keep it as an
 * NPC. Opened from the "Contract Manager" scene-control tool (settlement-controls.js).
 */
export class ContractManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _updateHook = null;
  _timeHook = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-contract-manager`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.stable.contract.managerTitle", resizable: true },
    position: { width: 760, height: 480 },
    actions: {
      requestPayment:      ContractManagerApp.#onRequestPayment,
      revokeContract:      ContractManagerApp.#onRevokeContract,
      openContractDetails: ContractManagerApp.#onOpenContractDetails
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/contract-manager.hbs` }
  };

  async _prepareContext(options) {
    const { currencies } = getCurrencyContext();
    const now = game.time.worldTime;
    const rows = game.actors
      .filter(a => a.getFlag(MODULE_ID, FLAGS.CONTRACT)?.status === "active")
      .map(a => {
        const c = a.getFlag(MODULE_ID, FLAGS.CONTRACT);
        const isWage = c.contractTerms === "wages" || c.contractTerms === "both";
        const isTreasure = c.contractTerms === "treasure" || c.contractTerms === "both";
        const accrued = accrueContract(c, now);
        const periodLabel = game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.bank.loans.period.${c.wagePeriod ?? "week"}`);
        return {
          actorUuid: a.uuid,
          actorName: a.name,
          actorImg: a.img,
          hiringActorName: c.hiringActorName,
          termsLabel: contractTermsLabel(c.contractTerms),
          wageRateLabel: isWage ? game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.stable.contract.wageRate", {
            amount: formatAmounts(c.wageCoins ?? {}, currencies), period: periodLabel
          }) : "",
          owedLabel: isWage ? formatAmounts(contractOwedCoins(accrued.owedStandard, currencies), currencies) : "",
          treasureShareLabel: isTreasure ? treasureShareLabel(c.treasureShare) : ""
        };
      });
    return { rows, hasRows: rows.length > 0 };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this._updateHook) {
      this._updateHook = Hooks.on("updateActor", () => this.render({ parts: ["content"] }));
    }
    if (!this._timeHook) {
      const debounced = foundry.utils.debounce(() => this.render({ parts: ["content"] }), 250);
      this._timeHook = Hooks.on("updateWorldTime", () => debounced());
    }
  }

  async _onClose(options) {
    await super._onClose(options);
    if (this._updateHook) { Hooks.off("updateActor", this._updateHook); this._updateHook = null; }
    if (this._timeHook) { Hooks.off("updateWorldTime", this._timeHook); this._timeHook = null; }
  }

  static #onRequestPayment() {
    ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.requestPaymentStub"));
  }

  static async #onOpenContractDetails(event, target) {
    const actor = await fromUuid(target.dataset.actorUuid).catch(() => null);
    if (actor) ContractDetailsApp.open(actor);
  }

  static async #onRevokeContract(event, target) {
    const actor = await fromUuid(target.dataset.actorUuid).catch(() => null);
    if (!actor) return;

    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.revokeTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.stable.contract.revokeConfirm", { name: foundry.utils.escapeHTML(actor.name) })}</p>`,
      rejectClose: false
    });
    if (!ok) return;

    const fate = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.revokeFateTitle") },
      content: `<p>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.revokeFateBody")}</p>`,
      buttons: [
        { action: "delete", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.revokeDelete"), icon: "fa-solid fa-trash", callback: () => "delete" },
        { action: "keep",   label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.revokeKeep"),   icon: "fa-solid fa-user",  default: true, callback: () => "keep" }
      ],
      rejectClose: false
    });
    if (!fate) return;

    // Strip every non-GM owner back to no access, regardless of the actor's fate.
    const ownership = { default: 0 };
    for (const k of Object.keys(actor.ownership ?? {})) if (k !== "default") ownership[k] = 0;
    await actor.update({ ownership });

    if (fate === "delete") await actor.delete();
    else await actor.unsetFlag(MODULE_ID, FLAGS.CONTRACT); // now a plain GM NPC

    this.render({ parts: ["content"] });
  }
}
