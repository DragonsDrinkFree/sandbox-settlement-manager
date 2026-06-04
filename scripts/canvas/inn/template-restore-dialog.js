import { MODULE_ID } from "../../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class TemplateRestoreDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _innData;
  _template;
  _onSave;

  constructor(innData, template, onSave, options = {}) {
    super(options);
    this._innData  = innData;
    this._template = template;
    this._onSave   = onSave;
  }

  get title() {
    return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.restore.title");
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-template-restore`,
    tag: "form",
    form: { handler: TemplateRestoreDialog.#onSubmit, closeOnSubmit: true },
    position: { width: 420 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/inn/template-restore-dialog.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(innData, template, onSave) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-template-restore`);
    if (existing) existing.close();
    const app = new TemplateRestoreDialog(
      foundry.utils.deepClone(innData),
      template,
      onSave
    );
    app.render(true);
    return app;
  }

  async _prepareContext(options) {
    const tLodgings = this._template?.typeData?.lodgings ?? [];
    const tCourses  = this._template?.typeData?.menu?.courses ?? [];
    const rLodgings = this._innData.lodgings ?? [];
    const rCourses  = this._innData.menu?.courses ?? [];

    const changedLodgings = rLodgings.filter(l => l.overridden && l.templateItemId);
    const missingLodgings = tLodgings.filter(tl => !rLodgings.some(l => l.templateItemId === tl.id));
    const changedCourses  = rCourses.filter(c => c.overridden && c.templateItemId);
    const missingCourses  = tCourses.filter(tc => !rCourses.some(c => c.templateItemId === tc.id));
    const hasAnyItems     = !!(changedLodgings.length || missingLodgings.length ||
                               changedCourses.length  || missingCourses.length);

    return {
      changedLodgings,
      missingLodgings,
      changedCourses,
      missingCourses,
      hasAnyItems,
      buttons: [{ type: "submit", icon: "fa-solid fa-rotate-left", label: "Restore Selected" }]
    };
  }

  static async #onSubmit(event, form) {
    const innData  = foundry.utils.deepClone(this._innData);
    const template = this._template;
    const checked  = [...form.querySelectorAll('input[type="checkbox"][data-restore-id]:checked')];

    for (const cb of checked) {
      const kind     = cb.dataset.restoreKind;
      const category = cb.dataset.restoreCategory;
      const id       = cb.dataset.restoreId;

      if (category === "lodging") {
        if (kind === "changed") {
          const l  = innData.lodgings.find(x => x.id === id);
          if (!l) continue;
          const tl = (template?.typeData?.lodgings ?? []).find(x => x.id === l.templateItemId);
          if (!tl) continue;
          Object.assign(l, { ...foundry.utils.deepClone(tl), id: l.id, templateItemId: l.templateItemId, overridden: false });
        } else {
          const tl = (template?.typeData?.lodgings ?? []).find(x => x.id === id);
          if (!tl) continue;
          innData.lodgings.push({ ...foundry.utils.deepClone(tl), templateItemId: tl.id, overridden: false });
        }
      } else if (category === "course") {
        if (kind === "changed") {
          const courses = innData.menu?.courses ?? [];
          const idx = courses.findIndex(x => x.id === id);
          if (idx === -1) continue;
          const tc = (template?.typeData?.menu?.courses ?? []).find(x => x.id === courses[idx].templateItemId);
          if (!tc) continue;
          courses[idx] = { ...foundry.utils.deepClone(tc), id: courses[idx].id, templateItemId: courses[idx].templateItemId, overridden: false };
        } else {
          const tc = (template?.typeData?.menu?.courses ?? []).find(x => x.id === id);
          if (!tc) continue;
          innData.menu ??= { courses: [] };
          innData.menu.courses ??= [];
          innData.menu.courses.push({ ...foundry.utils.deepClone(tc), templateItemId: tc.id, overridden: false });
        }
      }
    }

    await this._onSave(innData);
  }
}
