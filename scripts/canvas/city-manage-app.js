import { MODULE_ID, FLAGS, SETTINGS, RESOURCE_TYPE_IDS, CORE_RESOURCE_TYPES } from "../constants.js";
import { ResourceEditApp } from "./resource-edit-app.js";
import { CurrencyTestConfigApp } from "./currency-test-config.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CityManageApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-city-manage`,
    window: { title: "SANDBOX_CITY_MANAGER.manage.title", resizable: true },
    position: { width: 440, height: "auto" },
    actions: {
      addResource:        CityManageApp.#onAddResource,
      editResource:       CityManageApp.#onEditResource,
      deleteResource:     CityManageApp.#onDeleteResource,
      toggleDiscovered:   CityManageApp.#onToggleDiscovered,
      configureExpenses:  CityManageApp.#onConfigureExpenses
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/city-manage.hbs`, scrollable: [""] }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const scene = canvas.scene;
    context.cityName = scene?.getFlag(MODULE_ID, FLAGS.CITY_NAME) ?? "";
    context.cityTypes = game.settings.get(MODULE_ID, SETTINGS.CITY_TYPES)
      .map(t => ({ value: t.name, label: t.name }));
    context.selectedType = scene?.getFlag(MODULE_ID, FLAGS.CITY_TYPE) ?? "";
    context.resources = this.#enrichResources();
    return context;
  }

  #enrichResources() {
    const raw = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    const subTypeMap = Array.isArray(raw) ? {} : (raw ?? {});
    const instances = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    return instances.map(r => {
      const type = CORE_RESOURCE_TYPES.find(t => t.id === r.typeId);
      const subType = (subTypeMap[r.typeId] ?? []).find(s => s.id === r.subTypeId) ?? null;
      return {
        ...r,
        typeName: type?.name ?? game.i18n.localize("SANDBOX_CITY_MANAGER.resource.unknownType"),
        typeIcon: type?.icon ?? "fa-solid fa-question",
        subTypeName: subType?.name ?? null,
        isCurrencyTest: r.typeId === RESOURCE_TYPE_IDS.CURRENCY_TEST
      };
    });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    // All three detail fields save immediately on change
    this.element.querySelector('[name="cityName"]')?.addEventListener("change", e => {
      canvas.scene?.setFlag(MODULE_ID, FLAGS.CITY_NAME, e.target.value);
    });
    this.element.querySelector('[name="cityType"]')?.addEventListener("change", e => {
      canvas.scene?.setFlag(MODULE_ID, FLAGS.CITY_TYPE, e.target.value);
    });
  }

  // Toggle discovered inline — updates icon in place without re-rendering the whole window
  static async #onToggleDiscovered(event, target) {
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const resource = resources.find(r => r.id === id);
    if (!resource) return;
    resource.discovered.default = !resource.discovered.default;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    const icon = target.querySelector("i");
    if (icon) icon.className = resource.discovered.default ? "fa-solid fa-eye" : "fa-regular fa-eye-slash";
    target.classList.toggle("is-discovered", resource.discovered.default);
  }

  static async #onAddResource() {
    const result = await ResourceEditApp.open({});
    if (!result) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    resources.push(result);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this.render({ parts: ["content"] });
  }

  static async #onEditResource(event, target) {
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const index = resources.findIndex(r => r.id === id);
    if (index === -1) return;
    const result = await ResourceEditApp.open(resources[index]);
    if (!result) return;
    resources[index] = result;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this.render({ parts: ["content"] });
  }

  static async #onDeleteResource(event, target) {
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const index = resources.findIndex(r => r.id === id);
    if (index === -1) return;
    resources.splice(index, 1);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this.render({ parts: ["content"] });
  }

  static #onConfigureExpenses(event, target) {
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const resource = resources.find(r => r.id === id);
    if (!resource) return;
    CurrencyTestConfigApp.open(resource, canvas.scene);
  }
}
