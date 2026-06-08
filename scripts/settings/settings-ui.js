import { MODULE_ID } from "../constants.js";

/**
 * Insert a visual divider in the core Settings form between this module's config menus
 * and its plain time settings (Hours Per Day / Days Per Week). v13 SettingsConfig renders
 * all of a module's menus first, then its config:true settings, so the divider sits before
 * the first setting (hoursPerDay).
 */
export function registerSettingsUI() {
  Hooks.on("renderSettingsConfig", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const input = root.querySelector(`[name="${MODULE_ID}.hoursPerDay"]`);
    const group = input?.closest(".form-group");
    if (!group) return;
    if (group.previousElementSibling?.classList?.contains("ssm-settings-divider")) return;
    const hr = document.createElement("hr");
    hr.className = "ssm-settings-divider";
    group.parentNode.insertBefore(hr, group);
  });
}
