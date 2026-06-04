import { MODULE_ID, SETTINGS } from "../../constants.js";
import { MenuItemEditApp } from "./menu-item-edit-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CourseEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _course;
  _templateCourse;

  constructor(course, templateCourse, options = {}) {
    super(options);
    this._course         = foundry.utils.deepClone(course);
    this._templateCourse = templateCourse ?? null;
  }

  get title() {
    return game.i18n.localize(
      this._course?.name
        ? "SANDBOX_SETTLEMENT_MANAGER.inn.course.editTitle"
        : "SANDBOX_SETTLEMENT_MANAGER.inn.course.addTitle"
    );
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-course-edit`,
    tag: "form",
    form: { handler: CourseEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 520 },
    actions: {
      addItem:    CourseEditApp.#onAddItem,
      editItem:   CourseEditApp.#onEditItem,
      deleteItem: CourseEditApp.#onDeleteItem
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/inn/course-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(course = {}, templateCourse = null) {
    return new Promise(resolve => {
      const existing = foundry.applications.instances.get(`${MODULE_ID}-course-edit`);
      if (existing) existing.close();
      const app = new CourseEditApp(course, templateCourse);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const defaultCurrencyId = currencies[0]?.id ?? "";
    const isRandom = this._course.mode === "random";
    const hasCoursePrice = !!this._course.price;
    const items = isRandom ? (this._course.pool ?? []) : (this._course.items ?? []);
    return {
      course: {
        name:            this._course.name            ?? "",
        mode:            this._course.mode            ?? "static",
        drawCount:       this._course.drawCount       ?? 3,
        refreshCadence:  this._course.refreshCadence  ?? "daily",
        price: {
          currencyId: this._course.price?.currencyId ?? defaultCurrencyId,
          amount:     this._course.price?.amount     ?? 0
        }
      },
      isRandom,
      hasCoursePrice,
      items,
      currencies,
      hasTemplate: !!this._templateCourse,
      buttons: this._templateCourse
        ? [
            { type: "button", icon: "fa-solid fa-rotate-left", label: "Restore to Template", cssClass: "restore-template-btn" },
            { type: "submit", icon: "fa-solid fa-save", label: "Save" }
          ]
        : [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this._course.name) this.element.querySelector('[name="name"]')?.focus();

    this.element.querySelector('.restore-template-btn')?.addEventListener("click", () => {
      const t = this._templateCourse;
      if (!t) return;
      const resolve = this._resolve;
      this._resolve = null;
      resolve?.({
        ...foundry.utils.deepClone(t),
        id:             this._course.id || foundry.utils.randomID(),
        templateItemId: this._course.templateItemId ?? null,
        overridden:     false,
        _restored:      true
      });
      this.close();
    });

    const modeRadios   = this.element.querySelectorAll('[name="mode"]');
    const randomFields = this.element.querySelector(".random-fields");
    const priceCheckbox = this.element.querySelector('[name="hasCoursePrice"]');
    const priceFields   = this.element.querySelector(".course-price-fields");

    const toggleRandom = () => {
      const isRandom = this.element.querySelector('[name="mode"]:checked')?.value === "random";
      if (randomFields) randomFields.hidden = !isRandom;
    };
    const togglePrice = () => {
      if (priceFields) priceFields.hidden = !priceCheckbox?.checked;
    };

    toggleRandom();
    togglePrice();
    modeRadios.forEach(r => r.addEventListener("change", toggleRandom));
    priceCheckbox?.addEventListener("change", togglePrice);
  }

  #syncCourseFromDOM() {
    const el = this.element;
    if (!el) return;
    this._course.name           = (el.querySelector('[name="name"]')?.value ?? "").trim();
    this._course.mode           = el.querySelector('[name="mode"]:checked')?.value === "random" ? "random" : "static";
    this._course.drawCount      = Math.max(1, parseInt(el.querySelector('[name="drawCount"]')?.value) || 1);
    this._course.refreshCadence = el.querySelector('[name="refreshCadence"]:checked')?.value === "weekly" ? "weekly" : "daily";
    const hasCoursePrice        = !!el.querySelector('[name="hasCoursePrice"]')?.checked;
    this._course.price = hasCoursePrice ? {
      currencyId: el.querySelector('[name="priceCurrencyId"]')?.value ?? "",
      amount:     parseFloat(el.querySelector('[name="priceAmount"]')?.value) || 0
    } : null;
  }

  static async #onAddItem() {
    this.#syncCourseFromDOM();
    const result = await MenuItemEditApp.open({});
    if (!result) return;
    const isRandom = this._course.mode === "random";
    if (isRandom) {
      this._course.pool ??= [];
      this._course.pool.push(result);
    } else {
      this._course.items ??= [];
      this._course.items.push(result);
    }
    this.render();
  }

  static async #onEditItem(event, target) {
    this.#syncCourseFromDOM();
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const isRandom = this._course.mode === "random";
    const list = isRandom ? (this._course.pool ?? []) : (this._course.items ?? []);
    const index = list.findIndex(i => i.id === itemId);
    if (index === -1) return;
    const result = await MenuItemEditApp.open(list[index]);
    if (!result) return;
    list[index] = result;
    this.render();
  }

  static #onDeleteItem(event, target) {
    this.#syncCourseFromDOM();
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const isRandom = this._course.mode === "random";
    if (isRandom) {
      this._course.pool = (this._course.pool ?? []).filter(i => i.id !== itemId);
    } else {
      this._course.items = (this._course.items ?? []).filter(i => i.id !== itemId);
    }
    this.render();
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;
    const mode            = formData.object.mode === "random" ? "random" : "static";
    const hasCoursePrice  = !!formData.object.hasCoursePrice;
    const price = hasCoursePrice ? {
      currencyId: formData.object.priceCurrencyId ?? "",
      amount:     parseFloat(formData.object.priceAmount) || 0
    } : null;
    const drawCount      = Math.max(1, parseInt(formData.object.drawCount) || 1);
    const refreshCadence = formData.object.refreshCadence === "weekly" ? "weekly" : "daily";

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id:             this._course.id || foundry.utils.randomID(),
      name,
      mode,
      price,
      drawCount,
      refreshCadence,
      items:          mode === "static"  ? (this._course.items  ?? []) : [],
      pool:           mode === "random"  ? (this._course.pool   ?? []) : [],
      drawnItems:     mode === "random"  ? (this._course.drawnItems ?? []) : [],
      lastRefreshed:  this._course.lastRefreshed ?? null,
      templateItemId: this._course.templateItemId ?? null,
      overridden:     this._course.overridden ?? false
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
