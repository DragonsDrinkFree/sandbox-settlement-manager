import { MODULE_ID, FLAGS } from "../constants.js";
import { getCurrencyContext, formatAmounts } from "../utils/currency-utils.js";
import { getWorldTimeConfig } from "../time/world-time.js";
import { accrueContract, contractOwedCoins, contractTermsLabel, treasureShareLabel, buildContractRecord } from "../utils/contract-utils.js";
import { ContractDetailsApp } from "./contract-details-app.js";
import { ContractCreateApp } from "./contract-create-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only window listing every active Stable contract: which actor it applies to, who is hiring,
 * the terms, and the wage owed so far (accrued on-read). "Request Payment" is a stub. "Revoke"
 * terminates player ownership of the hired actor and lets the GM either delete it or keep it as an
 * NPC. Opened from the "Contract Manager" scene-control tool (settlement-controls.js).
 */
export class ContractManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _updateHook = null;
  _createHook = null;
  _deleteHook = null;
  _timeHook = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-contract-manager`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.stable.contract.managerTitle", resizable: true },
    position: { width: 760, height: 480 },
    actions: {
      createContract:      ContractManagerApp.#onCreateContract,
      refreshContracts:    ContractManagerApp.#onRefreshContracts,
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
    // A contract actor is always freshly created (negotiated-accept or manual "+ New Contract"), so
    // without a createActor hook this window would never notice one appear on its own while open.
    if (!this._createHook) {
      this._createHook = Hooks.on("createActor", () => this.render({ parts: ["content"] }));
    }
    if (!this._deleteHook) {
      this._deleteHook = Hooks.on("deleteActor", () => this.render({ parts: ["content"] }));
    }
    if (!this._timeHook) {
      const debounced = foundry.utils.debounce(() => this.render({ parts: ["content"] }), 250);
      this._timeHook = Hooks.on("updateWorldTime", () => debounced());
    }

    this.element.querySelectorAll('.ssm-item-link[data-uuid]').forEach(link => {
      link.addEventListener('click', async () => {
        const actor = await fromUuid(link.dataset.uuid).catch(() => null);
        actor?.sheet?.render(true);
      });
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    if (this._updateHook) { Hooks.off("updateActor", this._updateHook); this._updateHook = null; }
    if (this._createHook) { Hooks.off("createActor", this._createHook); this._createHook = null; }
    if (this._deleteHook) { Hooks.off("deleteActor", this._deleteHook); this._deleteHook = null; }
    if (this._timeHook) { Hooks.off("updateWorldTime", this._timeHook); this._timeHook = null; }
  }

  static #onRefreshContracts() {
    this.render({ parts: ["content"] });
  }

  static async #onCreateContract() {
    const result = await ContractCreateApp.open();
    if (!result) return;

    const sourceActor = game.actors.get(result.sourceActorId);
    const hiringActor = game.actors.get(result.hiringActorId);
    if (!sourceActor || !hiringActor) return;

    if (result.mode === "link" && sourceActor.getFlag(MODULE_ID, FLAGS.CONTRACT)?.status === "active") {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.alreadyContractedTitle") },
        content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.stable.contract.alreadyContractedConfirm", { name: foundry.utils.escapeHTML(sourceActor.name) })}</p>`,
        rejectClose: false
      });
      if (!ok) return;
    }

    const { currencies } = getCurrencyContext();
    const { hoursPerDay } = getWorldTimeConfig();
    const contract = buildContractRecord({
      contractTerms: result.contractTerms,
      sourceActorName: sourceActor.name, sourceActorUuid: sourceActor.uuid,
      hiringActorId: hiringActor.id, hiringActorName: hiringActor.name,
      wageAmount: result.wageAmount, wageCurrencyId: result.wageCurrencyId, wagePeriod: result.wagePeriod,
      treasureShare: result.treasureShare,
      currencies, hoursPerDay, now: game.time.worldTime
    });

    // Same ownership model as a negotiated-and-accepted contract: the linked/cloned actor ends up
    // owned by every non-GM owner of the hiring character.
    const ownership = { default: 0 };
    for (const u of game.users.filter(u => !u.isGM && hiringActor.testUserPermission(u, "OWNER"))) {
      ownership[u.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    }

    if (result.mode === "clone") {
      const actorData = sourceActor.toObject();
      delete actorData._id;
      delete actorData.folder;
      actorData.ownership = ownership;
      foundry.utils.setProperty(actorData, `flags.${MODULE_ID}.${FLAGS.CONTRACT}`, contract);
      await Actor.create(actorData);
    } else {
      await sourceActor.update({ ownership, [`flags.${MODULE_ID}.${FLAGS.CONTRACT}`]: contract });
    }

    this.render({ parts: ["content"] });
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
