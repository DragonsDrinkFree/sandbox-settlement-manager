import { MODULE_ID, FLAGS, CORE_LOCATION_TYPES, getTypeEntries } from "../constants.js";
import { LocationDetailApp } from "./location-detail-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class SettlementLocationsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _sceneUpdateHook = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-settlement-locations`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.locations.title", resizable: false },
    position: { width: 280 }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/settlement-locations.hbs` }
  };

  async _prepareContext(options) {
    const instances = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
    const locations = instances
      .filter(r => r.discovered?.default === true)
      .map(r => {
        const seenTypeIds = new Set();
        const types = getTypeEntries(r)
          .filter(e => !seenTypeIds.has(e.typeId) && seenTypeIds.add(e.typeId))
          .map(e => CORE_LOCATION_TYPES.find(t => t.id === e.typeId))
          .filter(Boolean)
          .map(t => ({ id: t.id, name: t.name, icon: t.icon }));
        return { ...r, types };
      });
    return { locations, hasDiscovered: locations.length > 0 };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this.element.querySelectorAll(".location-entry").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.dataset.locationId;
        const instances = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
        const location = instances.find(r => r.id === id);
        if (location) LocationDetailApp.open(location);
      });
    });

    if (!this._sceneUpdateHook) {
      this._sceneUpdateHook = Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas.scene?.id) return;
        if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.LOCATIONS}`)) return;
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
