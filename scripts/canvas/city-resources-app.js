import { MODULE_ID, FLAGS, CORE_RESOURCE_TYPES, getTypeEntries } from "../constants.js";
import { ResourceDetailApp } from "./resource-detail-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CityResourcesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _sceneUpdateHook = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-city-resources`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.resources.title", resizable: false },
    position: { width: 280 }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/city-resources.hbs` }
  };

  async _prepareContext(options) {
    const instances = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const resources = instances
      .filter(r => r.discovered?.default === true)
      .map(r => {
        const seenTypeIds = new Set();
        const types = getTypeEntries(r)
          .filter(e => !seenTypeIds.has(e.typeId) && seenTypeIds.add(e.typeId))
          .map(e => CORE_RESOURCE_TYPES.find(t => t.id === e.typeId))
          .filter(Boolean)
          .map(t => ({ id: t.id, name: t.name, icon: t.icon }));
        return { ...r, types };
      });
    return { resources, hasDiscovered: resources.length > 0 };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this.element.querySelectorAll(".resource-entry").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.dataset.resourceId;
        const instances = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
        const resource = instances.find(r => r.id === id);
        if (resource) ResourceDetailApp.open(resource);
      });
    });

    if (!this._sceneUpdateHook) {
      this._sceneUpdateHook = Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas.scene?.id) return;
        if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.RESOURCES}`)) return;
        this.render();
      });
    }
  }

  async _onClose(options) {
    await super._onClose(options);
    if (this._sceneUpdateHook) {
      Hooks.off("updateScene", this._sceneUpdateHook);
      this._sceneUpdateHook = null;
    }
  }
}
