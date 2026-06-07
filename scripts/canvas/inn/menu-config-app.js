import { MODULE_ID, SETTINGS } from "../../constants.js";
import { CourseEditApp } from "./course-edit-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class MenuConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _menu;
  _onSave;
  _template;

  constructor(menu, onSave, template, options = {}) {
    super(options);
    this._menu     = foundry.utils.deepClone(menu);
    this._onSave   = onSave;
    this._template = template ?? null;
  }

  get title() {
    return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.menu.configureTitle");
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-menu-config`,
    window: { resizable: false },
    position: { width: 480 },
    actions: {
      addCourse:    MenuConfigApp.#onAddCourse,
      editCourse:   MenuConfigApp.#onEditCourse,
      deleteCourse: MenuConfigApp.#onDeleteCourse
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/inn/menu-config.hbs` }
  };

  static async open(menu, onSave, template = null) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-menu-config`);
    if (existing) existing.close();
    const app = new MenuConfigApp(menu, onSave, template);
    app.render(true);
    return app;
  }

  async _prepareContext(options) {
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const courses = (this._menu.courses ?? []).map(c => {
      const isRandom = c.mode === "random";
      const itemCount = isRandom ? (c.pool?.length ?? 0) : (c.items?.length ?? 0);
      let priceLabel = null;
      if (c.price) {
        const curr = currencies.find(x => x.id === c.price.currencyId);
        priceLabel = `${c.price.amount} ${curr?.abbreviation ?? "?"}`;
      }
      return { ...c, isRandom, itemCount, priceLabel };
    });
    return { courses };
  }

  static async #onAddCourse() {
    const result = await CourseEditApp.open({});
    if (!result) return;
    this._menu.courses ??= [];
    this._menu.courses.push(result);
    await this._onSave(foundry.utils.deepClone(this._menu));
    this.render();
  }

  static async #onEditCourse(event, target) {
    const courseId = target.dataset.courseId;
    if (!courseId) return;
    const index = (this._menu.courses ?? []).findIndex(c => c.id === courseId);
    if (index === -1) return;
    const course = this._menu.courses[index];
    const templateCourse = course.templateItemId
      ? (this._template?.typeData?.menu?.courses ?? []).find(c => c.id === course.templateItemId) ?? null
      : null;
    const result = await CourseEditApp.open(course, templateCourse);
    if (!result) return;
    if (result.templateItemId && !result._restored) result.overridden = true;
    delete result._restored;
    this._menu.courses[index] = result;
    await this._onSave(foundry.utils.deepClone(this._menu));
    this.render();
  }

  static async #onDeleteCourse(event, target) {
    const courseId = target.dataset.courseId;
    if (!courseId) return;
    const course = (this._menu.courses ?? []).find(c => c.id === courseId);
    if (!course) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.menu.deleteCourseTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.inn.menu.deleteCourseConfirm", { name: course.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    this._menu.courses = (this._menu.courses ?? []).filter(c => c.id !== courseId);
    await this._onSave(foundry.utils.deepClone(this._menu));
    this.render();
  }
}
