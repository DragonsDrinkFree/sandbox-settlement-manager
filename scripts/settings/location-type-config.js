import { MODULE_ID, SETTINGS, CORE_LOCATION_TYPES } from "../constants.js";
import { SubTypeEditApp } from "./sub-type-edit.js";
import { syncNewTemplateItems } from "../canvas/template-sync.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class LocationTypeConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  // Working copy: { [typeId]: [{ id, name }] }
  _subTypes = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-location-type-config`,
    tag: "form",
    form: { handler: LocationTypeConfigApp.#onSubmit, closeOnSubmit: true },
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.setting.locationTypeConfig.name" },
    position: { width: 460 },
    actions: {
      addTemplate:    LocationTypeConfigApp.#onAddTemplate,
      editTemplate:   LocationTypeConfigApp.#onEditTemplate,
      deleteTemplate: LocationTypeConfigApp.#onDeleteTemplate
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/location-type-config.hbs`, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    if (this._subTypes === null) {
      const raw = game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES);
      this._subTypes = Array.isArray(raw) ? {} : foundry.utils.deepClone(raw ?? {});
    }
    const templates = [];
    for (const t of CORE_LOCATION_TYPES) {
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
    const result = await SubTypeEditApp.open({}, null, { allSubTypes: this._subTypes });
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
    const result = await SubTypeEditApp.open(existing, typeId, { allSubTypes: this._subTypes });
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
      game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES) ?? {}
    );
    await game.settings.set(MODULE_ID, SETTINGS.LOCATION_TYPES, this._subTypes);
    await syncNewTemplateItems(oldSubTypes, this._subTypes);
  }
}
