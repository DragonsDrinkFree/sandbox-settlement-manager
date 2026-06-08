import { MODULE_ID, SETTINGS, CORE_RESOURCE_TYPES } from "../constants.js";
import { SubTypeEditApp } from "./sub-type-edit.js";
import { syncNewTemplateItems } from "../canvas/template-sync.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ResourceTypeConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  // Working copy: { [typeId]: [{ id, name }] }
  _subTypes = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-resource-type-config`,
    tag: "form",
    form: { handler: ResourceTypeConfigApp.#onSubmit, closeOnSubmit: true },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.setting.resourceTypeConfig.name" },
    position: { width: 460 },
    actions: {
      addTemplate:    ResourceTypeConfigApp.#onAddTemplate,
      editTemplate:   ResourceTypeConfigApp.#onEditTemplate,
      deleteTemplate: ResourceTypeConfigApp.#onDeleteTemplate
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/resource-type-config.hbs`, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    if (this._subTypes === null) {
      const raw = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
      this._subTypes = Array.isArray(raw) ? {} : foundry.utils.deepClone(raw ?? {});
    }
    const templates = [];
    for (const t of CORE_RESOURCE_TYPES) {
      for (const [i, s] of (this._subTypes[t.id] ?? []).entries()) {
        templates.push({ typeId: t.id, typeIcon: t.icon, typeName: t.name, name: s.name, index: i });
      }
    }
    return {
      templates,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  static async #onAddTemplate() {
    const result = await SubTypeEditApp.open({}, null);
    if (!result) return;
    const typeId = result._templateTypeId;
    if (!typeId) return;
    delete result._templateTypeId;
    result.id ??= foundry.utils.randomID();
    this._subTypes[typeId] ??= [];
    this._subTypes[typeId].push(result);
    this.render({ parts: ["form"] });
  }

  static async #onEditTemplate(event, target) {
    const typeId = target.dataset.typeId;
    const index  = parseInt(target.dataset.templateIndex);
    if (!typeId || isNaN(index)) return;
    const existing = (this._subTypes[typeId] ?? [])[index];
    if (!existing) return;
    const result = await SubTypeEditApp.open(existing, typeId);
    if (!result) return;
    delete result._templateTypeId;
    this._subTypes[typeId][index] = result;
    this.render({ parts: ["form"] });
  }

  static #onDeleteTemplate(event, target) {
    const typeId = target.dataset.typeId;
    const index  = parseInt(target.dataset.templateIndex);
    if (!typeId || isNaN(index)) return;
    this._subTypes[typeId]?.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static async #onSubmit() {
    const oldSubTypes = foundry.utils.deepClone(
      game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES) ?? {}
    );
    await game.settings.set(MODULE_ID, SETTINGS.RESOURCE_TYPES, this._subTypes);
    await syncNewTemplateItems(oldSubTypes, this._subTypes);
  }
}
