import { MODULE_ID, FLAGS } from "../constants.js";
import { ContractDetailsApp } from "./contract-details-app.js";

/**
 * Inject a "Contract Details" button into the window frame of any actor sheet whose actor carries a
 * `flags[MODULE_ID].contract`, immediately left of the kebab (`[data-action="toggleControls"]`).
 *
 * ApplicationV2 offers no external API to contribute a window-frame header button to a sheet class
 * this module doesn't own, so this is DOM injection via the `renderActorSheetV2` hook — which fires
 * for every actor sheet (the `render<Class>` hook fires for each class in the inheritance chain, and
 * every Dolmenwood actor sheet extends `ActorSheetV2`). See reference/foundry-reference/
 * DocumentSheet-registration.md — the same technique the module uses for the shared Scene Config tab.
 * Feature-detected, idempotent, wrapped in try/catch so a future Dolmenwood DOM change can't break
 * sheet rendering.
 */
export function registerContractSheetButton() {
  Hooks.on("renderActorSheetV2", (app, element) => {
    try {
      if (!app.document?.getFlag(MODULE_ID, FLAGS.CONTRACT)) return;

      const root = element instanceof HTMLElement ? element : element?.[0];
      const header = root?.querySelector(".window-header");
      if (!header || header.querySelector(".ssm-contract-btn")) return; // idempotent — the hook re-fires on every render

      const label = game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.sheetButton");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "header-control icon fa-solid fa-file-signature ssm-contract-btn";
      btn.setAttribute("aria-label", label);
      btn.dataset.tooltip = label;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ContractDetailsApp.open(app.document);
      });

      const kebab = header.querySelector('[data-action="toggleControls"]');
      if (kebab) kebab.before(btn);
      else header.appendChild(btn);
    } catch (err) {
      console.error(`${MODULE_ID} | contract sheet button injection failed`, err);
    }
  });
}
