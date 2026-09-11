import { MODULE_ID, FLAGS } from "../constants.js";
import { SettlementManageApp } from "./settlement-manage-app.js";
import { ContractManagerApp } from "./contract-manager-app.js";

export function registerSettlementControls() {
  Hooks.on("getSceneControlButtons", controls => {
    const isSettlement = canvas?.scene?.getFlag(MODULE_ID, FLAGS.IS_SETTLEMENT) ?? false;
    if (!isSettlement) return;

    const tools = {
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
        icon: "fa-solid fa-house-chimney",
        button: true,
        onChange: () => {
          const existing = foundry.applications.instances.get(`${MODULE_ID}-settlement-manage`);
          if (existing) existing.close();
          else new SettlementManageApp().render({ force: true });
        }
      }
    };

    if (game.user.isGM) {
      tools.contracts = {
        name: "contracts",
        order: 2,
        title: "SANDBOX_SETTLEMENT_MANAGER.controls.contracts",
        icon: "fa-solid fa-file-signature",
        button: true,
        onChange: () => {
          const existing = foundry.applications.instances.get(`${MODULE_ID}-contract-manager`);
          if (existing) existing.close();
          else new ContractManagerApp().render({ force: true });
        }
      };
    }

    controls["sandbox-settlement"] = {
      name: "sandbox-settlement",
      order: 100,
      title: "SANDBOX_SETTLEMENT_MANAGER.controls.settlement",
      icon: "fa-solid fa-house-chimney",
      activeTool: "select",
      tools
    };
  });

  // Refresh controls when the IS_SETTLEMENT flag changes on the active scene.
  // render({ reset: true }) is required — it triggers #prepareControls() which re-fires
  // getSceneControlButtons. The deprecated initialize() omits reset and the hook never re-fires.
  Hooks.on("updateScene", (scene, changes) => {
    if (scene.id !== canvas.scene?.id) return;
    if (changes.flags?.[MODULE_ID]?.[FLAGS.IS_SETTLEMENT] === undefined) return;
    ui.controls.render({ reset: true });
  });
}
