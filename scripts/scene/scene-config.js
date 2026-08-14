import { MODULE_ID, FLAGS } from "../constants.js";
import { getSandboxSceneSection } from "./sandbox-scene-tab.js";

/**
 * Add this module's Scene settings to the shared Sandbox tab.
 *
 * A render hook rather than a SceneConfig subclass: only one module can be the default Scene sheet,
 * so subclassing would silently knock out any sibling Sandbox module that did the same. Render
 * hooks fire for every class in the inheritance chain, so this still runs even if some other module
 * does subclass SceneConfig.
 */
export function registerSceneConfigTab() {
  Hooks.on("renderSceneConfig", (app, element) => {
    const section = getSandboxSceneSection(app, element, {
      moduleId: MODULE_ID,
      legend:   game.modules.get(MODULE_ID)?.title ?? MODULE_ID
    });
    if (!section) return;   // already built on an earlier render — nothing to re-add

    const isSettlement = app.document.getFlag(MODULE_ID, FLAGS.IS_SETTLEMENT) ?? false;
    const group = document.createElement("div");
    group.className = "form-group";
    // Named flags.<module>.<key>, which DocumentSheetV2 reads into document.flags on submit.
    group.innerHTML = `
      <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.scene.isSettlement")}</label>
      <div class="form-fields">
        <input type="checkbox" name="flags.${MODULE_ID}.${FLAGS.IS_SETTLEMENT}" ${isSettlement ? "checked" : ""}>
      </div>
    `;
    section.append(group);
  });
}
