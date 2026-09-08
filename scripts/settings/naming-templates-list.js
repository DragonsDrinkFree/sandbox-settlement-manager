import { MODULE_ID } from "../constants.js";
import { NamingTemplateEditApp } from "./naming-template-edit.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Standalone list window for one Stable's Naming Templates, opened via the "Configure Naming
 * Templates" button in sub-type-edit.hbs instead of an inline fieldset. Each row's Edit/Add opens
 * the existing NamingTemplateEditApp modal; every change applies immediately to this window's own
 * working array (there's no separate Save — closing the window, by any means, resolves the caller's
 * open() promise with the current array). Mirrors the open()-returns-a-Promise convention shared by
 * every other modal editor in this module, but here the "resolve" always fires from _onClose rather
 * than from a submit handler, since there's nothing to cancel back out of.
 */
export class NamingTemplatesListApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _templates = [];

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-naming-templates-list`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.stable.namingTemplatesLegend" },
    position: { width: 420 },
    actions: {
      addNamingTemplate:    NamingTemplatesListApp.#onAddNamingTemplate,
      editNamingTemplate:   NamingTemplatesListApp.#onEditNamingTemplate,
      deleteNamingTemplate: NamingTemplatesListApp.#onDeleteNamingTemplate
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/settings/naming-templates-list.hbs` }
  };

  /** Resolves the (possibly edited) templates array once the window is closed. */
  static async open(templates = []) {
    return new Promise(resolve => {
      const app = new NamingTemplatesListApp();
      app._templates = foundry.utils.deepClone(templates);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      templates: this._templates.map(t => ({ ...t, pieceCount: (t.pieces ?? []).length }))
    };
  }

  static async #onAddNamingTemplate() {
    const result = await NamingTemplateEditApp.open(null);
    if (!result) return;
    this._templates.push(result);
    this.render();
  }

  static async #onEditNamingTemplate(event, target) {
    const id = target.dataset.templateId;
    const existing = this._templates.find(t => t.id === id);
    if (!existing) return;
    const result = await NamingTemplateEditApp.open(existing);
    if (!result) return;
    const index = this._templates.findIndex(t => t.id === id);
    if (index !== -1) this._templates[index] = result;
    this.render();
  }

  static #onDeleteNamingTemplate(event, target) {
    const id = target.dataset.templateId;
    this._templates = this._templates.filter(t => t.id !== id);
    this.render();
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(this._templates);
    this._resolve = null;
  }
}
