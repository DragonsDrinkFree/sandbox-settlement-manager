import { MODULE_ID, FLAGS } from "../constants.js";
import { CityManageApp } from "./city-manage-app.js";

export function registerCityControls() {
  Hooks.on("getSceneControlButtons", controls => {
    const isCity = canvas?.scene?.getFlag(MODULE_ID, FLAGS.IS_CITY) ?? false;
    if (!isCity) return;

    controls["sandbox-city"] = {
      name: "sandbox-city",
      order: 100,
      title: "SANDBOX_SETTLEMENT_MANAGER.controls.city",
      icon: "fa-solid fa-city",
      activeTool: "select",
      tools: {
        select: {
          name: "select",
          order: 0,
          title: "SANDBOX_SETTLEMENT_MANAGER.controls.select",
          icon: "fa-solid fa-expand"
        },
        manage: {
          name: "manage",
          order: 1,
          title: "SANDBOX_SETTLEMENT_MANAGER.controls.manage",
          icon: "fa-solid fa-city",
          button: true,
          onChange: () => {
            const existing = foundry.applications.instances.get(`${MODULE_ID}-city-manage`);
            if (existing) existing.close();
            else new CityManageApp().render({ force: true });
          }
        }
      }
    };
  });

  // Refresh controls when the IS_CITY flag changes on the active scene.
  // render({ reset: true }) is required — it triggers #prepareControls() which re-fires
  // getSceneControlButtons. The deprecated initialize() omits reset and the hook never re-fires.
  Hooks.on("updateScene", (scene, changes) => {
    if (scene.id !== canvas.scene?.id) return;
    if (changes.flags?.[MODULE_ID]?.[FLAGS.IS_CITY] === undefined) return;
    ui.controls.render({ reset: true });
  });
}
