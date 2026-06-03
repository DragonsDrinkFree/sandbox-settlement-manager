import { MODULE_ID, FLAGS, SETTINGS, CORE_RESOURCE_TYPES } from "../constants.js";
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
    const raw = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    const subTypeMap = Array.isArray(raw) ? {} : (raw ?? {});
    const instances = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const discovered = instances.filter(r => r.discovered?.default === true);

    const groupMap = {};
    for (const r of discovered) {
      if (!groupMap[r.typeId]) {
        const type = CORE_RESOURCE_TYPES.find(t => t.id === r.typeId);
        groupMap[r.typeId] = {
          typeId: r.typeId,
          typeName: type?.name ?? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.unknownType"),
          typeIcon: type?.icon ?? "fa-solid fa-question",
          resources: []
        };
      }
      const subType = (subTypeMap[r.typeId] ?? []).find(s => s.id === r.subTypeId);
      groupMap[r.typeId].resources.push({ ...r, subTypeName: subType?.name ?? null });
    }

    const knownOrder = CORE_RESOURCE_TYPES.map(t => t.id);
    const groups = [
      ...knownOrder.filter(id => groupMap[id]).map(id => groupMap[id]),
      ...Object.values(groupMap).filter(g => !knownOrder.includes(g.typeId))
    ];

    return { groups, hasDiscovered: groups.length > 0 };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    // Wire click on resource entries to open their detail view
    this.element.querySelectorAll(".resource-entry").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.dataset.resourceId;
        const instances = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
        const resource = instances.find(r => r.id === id);
        if (resource) ResourceDetailApp.open(resource);
      });
    });

    // Register once — auto-refresh when the scene's resources flag changes
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
