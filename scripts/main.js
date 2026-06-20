/**
 * Entry point for sandbox-settlement-manager.
 * Loaded as an ES module before the "init" hook fires (declared in module.json → esmodules).
 *
 * Hook order:
 *   "init"  — game object exists; register settings, keybindings, socket listeners.
 *             World data (actors, scenes, etc.) is NOT loaded yet.
 *   "ready" — world data loaded; safe to access game.actors, game.scenes, etc.
 */

import { MODULE_ID, FLAGS, SETTINGS, migrateLocation } from "./constants.js";
import { registerSettings } from "./settings/settings.js";
import { registerSettingsUI } from "./settings/settings-ui.js";
import { SetupWizardApp } from "./settings/setup-wizard-app.js";
import { SandboxSceneConfig } from "./scene/scene-config.js";
import { registerSettlementControls } from "./canvas/settlement-controls.js";
import { registerWorldTimeHooks } from "./time/world-time.js";
import { registerSocketHandlers } from "./socket.js";
import "./canvas/cart-manager.js";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

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

Hooks.on("canvasReady", () => {
  foundry.applications.instances.get(`${MODULE_ID}-settlement-manage`)?.close({ animate: false });
});

Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | Ready`);
  registerSocketHandlers();

  if (game.user.isGM) {
    // Migrate location data: add entryId to typeEntries, move flat typeData keys to entryId-keyed form.
    for (const scene of game.scenes) {
      const locations = scene.getFlag(MODULE_ID, FLAGS.LOCATIONS);
      if (!locations?.length) continue;
      const migrated = locations.map(migrateLocation);
      await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, migrated);
    }

    // Auto-open setup wizard on first run.
    if (!game.settings.get(MODULE_ID, SETTINGS.WIZARD_SHOWN)) {
      new SetupWizardApp().render(true);
    }
  }
});
