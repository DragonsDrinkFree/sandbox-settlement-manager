import { MODULE_ID, FLAGS, SETTINGS, RESOURCE_TYPE_IDS, CORE_RESOURCE_TYPES, getTypeEntries } from "../constants.js";
import { PurchaseDialog } from "./purchase-dialog.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { cartManager } from "./cart-manager.js";
import { CartApp } from "./cart-app.js";
import { MenuConfigApp } from "./inn/menu-config-app.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { readItemName, readItemPrice } from "../utils/item-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ResourceDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resource;
  _activeTab = null;
  _sceneUpdateHook = null;

  constructor(resource, options = {}) {
    super(options);
    this._resource = resource;
  }

  get title() { return this._resource.name; }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-resource-detail`,
    window: { resizable: false },
    position: { width: 420 },
    actions: {
      buyExpense:         ResourceDetailApp.#onBuyExpense,
      switchTab:          ResourceDetailApp.#onSwitchTab,
      addLodging:         ResourceDetailApp.#onAddLodging,
      editLodging:        ResourceDetailApp.#onEditLodging,
      deleteLodging:      ResourceDetailApp.#onDeleteLodging,
      rentLodging:        ResourceDetailApp.#onRentLodging,
      dismissLedgerEntry: ResourceDetailApp.#onDismissLedgerEntry,
      configureMenu:      ResourceDetailApp.#onConfigureMenu,
      refreshCourse:      ResourceDetailApp.#onRefreshCourse,
      buyMenuItem:        ResourceDetailApp.#onBuyMenuItem,
      buyInventoryItem:    ResourceDetailApp.#onBuyInventoryItem,
      deleteMerchantItem:  ResourceDetailApp.#onDeleteMerchantItem
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/resource-detail.hbs` }
  };

  static open(resource) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-resource-detail`);
    if (existing) existing.close();
    new ResourceDetailApp(resource).render(true);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this._sceneUpdateHook) {
      this._sceneUpdateHook = Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas.scene?.id) return;
        if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.RESOURCES}`)) return;
        const resources = canvas.scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
        const fresh = resources.find(r => r.id === this._resource.id);
        if (fresh) this._resource = fresh;
        this.render();
      });
    }

    // Wire merchant drop zone (GM only)
    if (game.user.isGM) {
      const dropZone = this.element.querySelector(".merchant-drop-zone");
      if (dropZone) {
        dropZone.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; dropZone.classList.add("drag-over"); });
        dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
        dropZone.addEventListener("drop",      e => { dropZone.classList.remove("drag-over"); this.#onMerchantDrop(e); });
      }
    }
  }

  async _onClose(options) {
    await super._onClose(options);
    if (this._sceneUpdateHook) {
      Hooks.off("updateScene", this._sceneUpdateHook);
      this._sceneUpdateHook = null;
    }
  }

  async _prepareContext(options) {
    const entries = getTypeEntries(this._resource);
    const typeIds = [...new Set(entries.map(e => e.typeId))];
    if (!this._activeTab || !typeIds.includes(this._activeTab)) {
      this._activeTab = typeIds[0] ?? null;
    }

    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const isGM = game.user.isGM;

    const tabs = typeIds.map(id => {
      const coreType = CORE_RESOURCE_TYPES.find(t => t.id === id);
      const isCurrencyTest = id === RESOURCE_TYPE_IDS.CURRENCY_TEST;
      const isInn          = id === RESOURCE_TYPE_IDS.INN;
      const isMerchant     = id === RESOURCE_TYPE_IDS.MERCHANT;

      const expenses = isCurrencyTest
        ? (this._resource.typeData?.expenses ?? []).map(e => {
            const c = currencies.find(x => x.id === e.currencyId);
            return { ...e, costLabel: `${e.amount} ${c?.abbreviation ?? "?"}` };
          })
        : [];

      const innData      = isInn      ? this.#buildInnData(currencies, isGM)      : null;
      const merchantData = isMerchant ? this.#buildMerchantData(currencies, isGM) : null;

      return {
        id,
        name: coreType?.name ?? id,
        icon: coreType?.icon ?? "fa-solid fa-question",
        active: id === this._activeTab,
        isCurrencyTest, isInn, isMerchant,
        expenses,
        innData,
        merchantData
      };
    });

    return { resource: this._resource, tabs, hasMultipleTabs: tabs.length > 1 };
  }

  #buildInnData(currencies, isGM) {
    const innRaw = this._resource.typeData?.inn ?? { lodgings: [], ledger: [] };
    const { daysPerWeek, hoursPerDay } = getWorldTimeConfig();
    const worldTime = game.time.worldTime;

    const lodgings = (innRaw.lodgings ?? []).map(l => {
      const dayCurr = currencies.find(c => c.id === l.pricePerDay?.currencyId);
      const dayLabel = `${l.pricePerDay?.amount ?? 0} ${dayCurr?.abbreviation ?? "?"}`;
      const weeklyAmount = l.pricePerWeek?.amount ?? ((l.pricePerDay?.amount ?? 0) * daysPerWeek);
      const weekCurr = l.pricePerWeek ? currencies.find(c => c.id === l.pricePerWeek.currencyId) : dayCurr;
      const weekLabel = `${weeklyAmount} ${weekCurr?.abbreviation ?? "?"}`;
      const avail     = l.availability ?? null;
      return {
        ...l,
        pricePerDayLabel:    dayLabel,
        pricePerWeekLabel:   weekLabel,
        availabilityDisplay: avail === null ? "∞" : String(avail),
        isSoldOut:           typeof avail === "number" && avail <= 0
      };
    });

    const allLedger = innRaw.ledger ?? [];
    const visibleLedger = isGM
      ? allLedger
      : allLedger.filter(e => e.actorId === game.user.character?.id);

    const ledger = visibleLedger.map(e => {
      const remaining = e.expiresAt - worldTime;
      const isExpired = remaining <= 0;
      let timeRemainingLabel;
      if (isExpired) {
        timeRemainingLabel = game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.expired");
      } else {
        const { totalDays, hour, minute } = secondsToComponents(remaining);
        timeRemainingLabel = `${totalDays}d ${hour}h ${String(minute).padStart(2, "0")}m`;
      }
      return { ...e, isExpired, timeRemainingLabel };
    });

    const menuData = this.#buildMenuData(innRaw, currencies, isGM, daysPerWeek, hoursPerDay, worldTime);
    if (menuData._needsSave && isGM) {
      const updatedInn = foundry.utils.deepClone(innRaw);
      updatedInn.menu = menuData._updatedMenu;
      this.#saveInnData(updatedInn).catch(() => {});
    }

    return { lodgings, ledger, isGM, menuData };
  }

  #buildMenuData(innRaw, currencies, isGM, daysPerWeek, hoursPerDay, worldTime) {
    const rawMenu = innRaw.menu ?? { courses: [] };
    const secondsPerDay  = (hoursPerDay ?? 24) * 3600;
    const secondsPerWeek = secondsPerDay * (daysPerWeek ?? 7);

    let _needsSave = false;
    const updatedCourses = foundry.utils.deepClone(rawMenu.courses ?? []);

    const courses = updatedCourses.map(course => {
      const isRandom = course.mode === "random";

      if (isRandom && isGM) {
        const cadenceSecs = course.refreshCadence === "weekly" ? secondsPerWeek : secondsPerDay;
        const due = (course.lastRefreshed ?? 0) + cadenceSecs;
        if (worldTime >= due && (course.pool ?? []).length > 0) {
          const shuffled = [...(course.pool ?? [])].sort(() => Math.random() - 0.5);
          course.drawnItems    = shuffled.slice(0, course.drawCount ?? 3);
          course.lastRefreshed = worldTime;
          _needsSave = true;
        }
      }

      const visibleItems = isRandom ? (course.drawnItems ?? []) : (course.items ?? []);
      let priceLabel = null;
      if (course.price) {
        const curr = currencies.find(c => c.id === course.price.currencyId);
        priceLabel = `${course.price.amount} ${curr?.abbreviation ?? "?"}`;
      }
      return {
        ...course,
        isRandom,
        priceLabel,
        visibleItems: visibleItems.map(item => {
          const resolvedPrice = item.price ?? course.price;
          let priceLabel = null;
          if (resolvedPrice) {
            const curr = currencies.find(c => c.id === resolvedPrice.currencyId);
            priceLabel = `${resolvedPrice.amount} ${curr?.abbreviation ?? "?"}`;
          }
          return { ...item, priceLabel, hasPrice: !!resolvedPrice };
        })
      };
    });

    return {
      courses,
      hasCourses: courses.length > 0,
      _needsSave,
      _updatedMenu: { courses: updatedCourses }
    };
  }

  async #saveInnData(innData) {
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const r = resources.find(r => r.id === this._resource.id);
    if (!r) return;
    r.typeData ??= {};
    r.typeData.inn = innData;
    this._resource = r;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this.render();
  }

  #buildMerchantData(currencies, isGM) {
    const inventory = (this._resource.typeData?.merchant?.inventory ?? []).map(item => {
      let priceLabel = "—";
      if (item.price) {
        const curr = currencies.find(c => c.id === item.price.currencyId);
        priceLabel = `${item.price.amount} ${curr?.abbreviation ?? "?"}`;
      }
      return { ...item, priceLabel };
    });
    return { inventory, isGM };
  }

  async #saveMerchantData(merchantData) {
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const r = resources.find(r => r.id === this._resource.id);
    if (!r) return;
    r.typeData ??= {};
    r.typeData.merchant = merchantData;
    this._resource = r;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this.render();
  }

  async #onMerchantDrop(event) {
    if (!game.user.isGM) return;
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data?.type !== "Item") return;
    const item = await fromUuid(data.uuid).catch(() => null);
    if (!item) return;

    const currencies = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const name  = readItemName(item);
    const price = readItemPrice(item, currencies);

    const merchant = foundry.utils.deepClone(this._resource.typeData?.merchant ?? { inventory: [] });
    merchant.inventory.push({ id: foundry.utils.randomID(), name, price, itemId: item.uuid, quantity: null });
    await this.#saveMerchantData(merchant);
  }

  static #onSwitchTab(event, target) {
    this._activeTab = target.dataset.tabId;
    this.render();
  }

  static async #onBuyExpense(event, target) {
    const id = target.closest("[data-expense-id]")?.dataset.expenseId;
    if (!id) return;
    const expense = this._resource.typeData?.expenses?.find(e => e.id === id);
    if (!expense) return;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    await PurchaseDialog.open({
      expense,
      currencies: currencyConfig.currencies ?? [],
      mode: currencyConfig.mode ?? "loose"
    });
  }

  static async #onAddLodging() {
    if (!game.user.isGM) return;
    const result = await LodgingEditApp.open({});
    if (!result) return;
    result.id ??= foundry.utils.randomID();
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.lodgings.push(result);
    await this.#saveInnData(innData);
  }

  static async #onEditLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    const index   = innData.lodgings.findIndex(l => l.id === lodgingId);
    if (index === -1) return;
    const lodging         = innData.lodgings[index];
    const template        = lodging.templateItemId ? this.#getTemplateForResource() : null;
    const templateLodging = template
      ? (template.typeData?.lodgings ?? []).find(l => l.id === lodging.templateItemId) ?? null
      : null;
    const result = await LodgingEditApp.open(lodging, templateLodging);
    if (!result) return;
    if (result.templateItemId && !result._restored) result.overridden = true;
    delete result._restored;
    innData.lodgings[index] = result;
    await this.#saveInnData(innData);
  }

  #getTemplateForResource() {
    const entry = getTypeEntries(this._resource).find(e => e.typeId === RESOURCE_TYPE_IDS.INN);
    if (!entry?.subTypeId) return null;
    const subTypes = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    return (subTypes[RESOURCE_TYPE_IDS.INN] ?? []).find(t => t.id === entry.subTypeId) ?? null;
  }

  static async #onDeleteLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.lodgings = innData.lodgings.filter(l => l.id !== lodgingId);
    await this.#saveInnData(innData);
  }

  static async #onRentLodging(event, target) {
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const lodging = this._resource.typeData?.inn?.lodgings?.find(l => l.id === lodgingId);
    if (!lodging) return;
    cartManager.addLodging({
      sceneId: canvas.scene?.id,
      resourceId: this._resource.id,
      resourceName: this._resource.name,
      lodging
    });
    CartApp.open();
  }

  static async #onDismissLedgerEntry(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.entryId;
    if (!entryId) return;
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.ledger = innData.ledger.filter(e => e.id !== entryId);
    await this.#saveInnData(innData);
  }

  static async #onConfigureMenu() {
    if (!game.user.isGM) return;
    const inn      = this._resource.typeData?.inn ?? { lodgings: [], ledger: [], menu: { courses: [] } };
    const template = this.#getTemplateForResource();
    await MenuConfigApp.open(
      inn.menu ?? { courses: [] },
      async (updatedMenu) => {
        const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
        innData.menu = updatedMenu;
        await this.#saveInnData(innData);
      },
      template
    );
  }

  static async #onRefreshCourse(event, target) {
    if (!game.user.isGM) return;
    const courseId = target.dataset.courseId;
    if (!courseId) return;
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    const course = (innData.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course || course.mode !== "random") return;
    const shuffled = [...(course.pool ?? [])].sort(() => Math.random() - 0.5);
    course.drawnItems    = shuffled.slice(0, course.drawCount ?? 3);
    course.lastRefreshed = game.time.worldTime;
    await this.#saveInnData(innData);
  }

  static async #onBuyMenuItem(event, target) {
    const { courseId, itemId } = target.dataset;
    if (!courseId || !itemId) return;
    const inn = this._resource.typeData?.inn;
    if (!inn) return;
    const course = (inn.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course) return;
    const allItems = course.mode === "random" ? (course.drawnItems ?? []) : (course.items ?? []);
    const item = allItems.find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMenuItem({
      sceneId: canvas.scene?.id,
      resourceId: this._resource.id,
      resourceName: this._resource.name,
      course,
      item
    });
    CartApp.open();
  }

  static async #onBuyInventoryItem(event, target) {
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const item = (this._resource.typeData?.merchant?.inventory ?? []).find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMerchantItem({
      sceneId: canvas.scene?.id,
      resourceId: this._resource.id,
      resourceName: this._resource.name,
      item
    });
    CartApp.open();
  }

  static async #onDeleteMerchantItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const merchant = foundry.utils.deepClone(this._resource.typeData?.merchant ?? { inventory: [] });
    merchant.inventory = merchant.inventory.filter(i => i.id !== itemId);
    await this.#saveMerchantData(merchant);
  }
}
