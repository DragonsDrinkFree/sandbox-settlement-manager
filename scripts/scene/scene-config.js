import { MODULE_ID, FLAGS } from "../constants.js";

export class SandboxSceneConfig extends SceneConfig {
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#ensureMarkAsSettlementCheckbox();
  }

  #ensureMarkAsSettlementCheckbox() {
    if (this.element.querySelector(`[name="flags.${MODULE_ID}.${FLAGS.IS_SETTLEMENT}"]`)) return;

    const basicsTab = this.element.querySelector('[data-application-part="basics"]');
    if (!basicsTab) return;

    const isSettlement = this.document.getFlag(MODULE_ID, FLAGS.IS_SETTLEMENT) ?? false;
    const group = document.createElement("div");
    group.className = "form-group";
    group.innerHTML = `
      <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.scene.isSettlement")}</label>
      <input type="checkbox" name="flags.${MODULE_ID}.${FLAGS.IS_SETTLEMENT}" ${isSettlement ? "checked" : ""}>
    `;
    basicsTab.prepend(group);
  }
}
