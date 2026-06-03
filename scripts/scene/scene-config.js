import { MODULE_ID, FLAGS } from "../constants.js";

export class SandboxSceneConfig extends SceneConfig {
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#ensureMarkAsCityCheckbox();
  }

  #ensureMarkAsCityCheckbox() {
    if (this.element.querySelector(`[name="flags.${MODULE_ID}.${FLAGS.IS_CITY}"]`)) return;

    const basicsTab = this.element.querySelector('[data-application-part="basics"]');
    if (!basicsTab) return;

    const isCity = this.document.getFlag(MODULE_ID, FLAGS.IS_CITY) ?? false;
    const group = document.createElement("div");
    group.className = "form-group";
    group.innerHTML = `
      <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.scene.isCity")}</label>
      <input type="checkbox" name="flags.${MODULE_ID}.${FLAGS.IS_CITY}" ${isCity ? "checked" : ""}>
    `;
    basicsTab.prepend(group);
  }
}
