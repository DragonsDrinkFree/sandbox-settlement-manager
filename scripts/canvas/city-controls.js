import { MODULE_ID, FLAGS } from "../constants.js";
import { CityManageApp } from "./city-manage-app.js";
import { CityResourcesApp } from "./city-resources-app.js";

export function registerCityControls() {
  Hooks.on("getSceneControlButtons", controls => {
    const isCity = canvas?.scene?.getFlag(MODULE_ID, FLAGS.IS_CITY) ?? false;
    if (!isCity) return;

    controls["sandbox-city"] = {
      name: "sandbox-city",
      order: 100,
      title: "SANDBOX_CITY_MANAGER.controls.city",
      icon: "fa-solid fa-city",
      activeTool: "select",
      tools: {
        select: {
          name: "select",
          order: 0,
          title: "SANDBOX_CITY_MANAGER.controls.select",
          icon: "fa-solid fa-expand"
        },
        manage: {
          name: "manage",
          order: 1,
          title: "SANDBOX_CITY_MANAGER.controls.manage",
          icon: "fa-solid fa-gears",
          button: true,
          visible: game.user.isGM,
          onChange: () => {
            const existing = foundry.applications.instances.get(`${MODULE_ID}-city-manage`);
            if (existing) existing.close();
            else new CityManageApp().render({ force: true });
          }
        },
        cityResources: {
          name: "cityResources",
          order: 2,
          title: "SANDBOX_CITY_MANAGER.controls.cityResources",
          icon: "fa-solid fa-warehouse",
          button: true,
          onChange: () => {
            const existing = foundry.applications.instances.get(`${MODULE_ID}-city-resources`);
            if (existing) existing.close();
            else new CityResourcesApp().render({ force: true });
          }
        }
      }
    };
  });

  // Refresh controls when the IS_CITY flag changes on the active scene
  Hooks.on("updateScene", (scene, changes) => {
    if (scene.id !== canvas.scene?.id) return;
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.IS_CITY}`)) return;
    ui.controls.initialize();
  });
}
