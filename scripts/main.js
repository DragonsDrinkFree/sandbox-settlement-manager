/**
 * Entry point for sandbox-settlement-manager.
 * Loaded as an ES module before the "init" hook fires (declared in module.json → esmodules).
 *
 * Hook order:
 *   "init"  — game object exists; register settings, keybindings, socket listeners.
 *             World data (actors, scenes, etc.) is NOT loaded yet.
 *   "ready" — world data loaded; safe to access game.actors, game.scenes, etc.
 */

import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings/settings.js";
import { registerSettingsUI } from "./settings/settings-ui.js";
import { SandboxSceneConfig } from "./scene/scene-config.js";
import { registerSettlementControls } from "./canvas/settlement-controls.js";
import { registerWorldTimeHooks } from "./time/world-time.js";
import { registerSocketHandlers } from "./socket.js";
import "./canvas/cart-manager.js";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  // Register keybindings FIRST — Foundry silently skips registration if earlier code throws.
  // See reference: Keybindings.md

  // Preload shared Handlebars partials (registered under short ids for {{> id}} use).
  foundry.applications.handlebars.loadTemplates({
    "ssm-price-input": `modules/${MODULE_ID}/templates/partials/price-input.hbs`
  });

  registerSettings();
  registerSettingsUI();
  registerSettlementControls();
  registerWorldTimeHooks();
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Scene, MODULE_ID, SandboxSceneConfig, {
    makeDefault: true
  });
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
  registerSocketHandlers();
});
