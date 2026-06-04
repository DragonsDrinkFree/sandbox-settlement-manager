import { MODULE_ID, SETTINGS, CORE_RESOURCE_TYPES } from "../constants.js";
import { ResourceTypeEditApp } from "./resource-type-edit.js";

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
      editCoreType: ResourceTypeConfigApp.#onEditCoreType
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
    return {
      coreTypes: CORE_RESOURCE_TYPES.map(t => ({
        ...t,
        subTypes: this._subTypes[t.id] ?? []
      })),
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  static async #onEditCoreType(event, target) {
    const typeId = target.dataset.typeId;
    const coreType = CORE_RESOURCE_TYPES.find(t => t.id === typeId);
    if (!coreType) return;
    const result = await ResourceTypeEditApp.open(coreType, this._subTypes[typeId] ?? []);
    if (result === null) return;
    this._subTypes[typeId] = result;
    this.render({ parts: ["form"] });
  }

  static async #onSubmit() {
    await game.settings.set(MODULE_ID, SETTINGS.RESOURCE_TYPES, this._subTypes);
  }
}
