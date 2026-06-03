import { MODULE_ID, SETTINGS, CORE_RESOURCE_TYPES } from "../constants.js";
import { SubTypeEditApp } from "./sub-type-edit.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ResourceTypeConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  // Working copy: { [typeId]: [{ id, name }] }
  _subTypes = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-resource-type-config`,
    tag: "form",
    form: { handler: ResourceTypeConfigApp.#onSubmit, closeOnSubmit: true },
    window: { title: "SANDBOX_CITY_MANAGER.setting.resourceTypeConfig.name" },
    position: { width: 460 },
    actions: {
      addSubType:    ResourceTypeConfigApp.#onAddSubType,
      editSubType:   ResourceTypeConfigApp.#onEditSubType,
      deleteSubType: ResourceTypeConfigApp.#onDeleteSubType
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

  static async #onAddSubType(event, target) {
    const typeId = target.dataset.typeId;
    const result = await SubTypeEditApp.open({});
    if (!result) return;
    result.id ??= foundry.utils.randomID();
    this._subTypes[typeId] ??= [];
    this._subTypes[typeId].push(result);
    this.render({ parts: ["form"] });
  }

  static async #onEditSubType(event, target) {
    const typeId = target.dataset.typeId;
    const index = parseInt(target.dataset.subIndex);
    const existing = this._subTypes[typeId]?.[index];
    if (!existing) return;
    const result = await SubTypeEditApp.open(existing);
    if (!result) return;
    this._subTypes[typeId][index] = result;
    this.render({ parts: ["form"] });
  }

  static #onDeleteSubType(event, target) {
    const typeId = target.dataset.typeId;
    const index = parseInt(target.dataset.subIndex);
    this._subTypes[typeId]?.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static async #onSubmit() {
    await game.settings.set(MODULE_ID, SETTINGS.RESOURCE_TYPES, this._subTypes);
  }
}
