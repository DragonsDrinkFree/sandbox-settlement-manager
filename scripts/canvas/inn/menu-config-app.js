import { MODULE_ID, SETTINGS } from "../../constants.js";
import { CourseEditApp } from "./course-edit-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class MenuConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _menu;
  _onSave;

  constructor(menu, onSave, options = {}) {
    super(options);
    this._menu   = foundry.utils.deepClone(menu);
    this._onSave = onSave;
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

  static async open(menu, onSave) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-menu-config`);
    if (existing) existing.close();
    const app = new MenuConfigApp(menu, onSave);
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
    const result = await CourseEditApp.open(this._menu.courses[index]);
    if (!result) return;
    this._menu.courses[index] = result;
    await this._onSave(foundry.utils.deepClone(this._menu));
    this.render();
  }

  static async #onDeleteCourse(event, target) {
    const courseId = target.dataset.courseId;
    if (!courseId) return;
    this._menu.courses = (this._menu.courses ?? []).filter(c => c.id !== courseId);
    await this._onSave(foundry.utils.deepClone(this._menu));
    this.render();
  }
}
