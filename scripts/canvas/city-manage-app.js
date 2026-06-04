import { MODULE_ID, FLAGS, SETTINGS, RESOURCE_TYPE_IDS, CORE_RESOURCE_TYPES, getTypeEntries } from "../constants.js";
import { ResourceEditApp } from "./resource-edit-app.js";
import { CurrencyTestConfigApp } from "./currency-test-config.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { LodgingRentalDialog } from "./inn/lodging-rental-dialog.js";
import { MenuConfigApp } from "./inn/menu-config-app.js";
import { PurchaseDialog } from "./purchase-dialog.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { SOCKET_CHANNEL, SOCKET_TYPES } from "../socket.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CityManageApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _selectedResourceId = null;
  _sceneUpdateHook = null;
  #pickerAbort = null;
  #pickerDropdown = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-city-manage`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.manage.title", resizable: true },
    position: { width: 750, height: 560 },
    actions: {
      addResource:        CityManageApp.#onAddResource,
      deleteResource:     CityManageApp.#onDeleteResource,
      toggleDiscovered:   CityManageApp.#onToggleDiscovered,
      configureExpenses:  CityManageApp.#onConfigureExpenses,
      selectResource:     CityManageApp.#onSelectResource,
      removeTypeEntry:    CityManageApp.#onRemoveTypeEntry,
      addLodging:         CityManageApp.#onAddLodging,
      editLodging:        CityManageApp.#onEditLodging,
      deleteLodging:      CityManageApp.#onDeleteLodging,
      rentLodging:        CityManageApp.#onRentLodging,
      dismissLedgerEntry: CityManageApp.#onDismissLedgerEntry,
      configureMenu:      CityManageApp.#onConfigureMenu,
      refreshCourse:      CityManageApp.#onRefreshCourse,
      buyMenuItem:        CityManageApp.#onBuyMenuItem
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/city-manage.hbs` }
  };

  // ------------------------------------------------------------------ context

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const scene = canvas.scene;
    const isGM = game.user.isGM;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];

    context.isGM         = isGM;
    context.cityName     = scene?.getFlag(MODULE_ID, FLAGS.CITY_NAME) ?? "";
    context.cityTypes    = game.settings.get(MODULE_ID, SETTINGS.CITY_TYPES)
      .map(t => ({ value: t.name, label: t.name }));
    context.selectedType = scene?.getFlag(MODULE_ID, FLAGS.CITY_TYPE) ?? "";
    context.resources    = this.#enrichResources(isGM);
    context.selectedResource = this.#buildSelectedResourceContext(currencies, isGM);
    return context;
  }

  #enrichResources(isGM = true) {
    const all = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const instances = isGM ? all : all.filter(r => r.discovered?.default === true);
    return instances.map(r => {
      const entries = getTypeEntries(r);
      const seenTypeIds = new Set();
      const types = entries
        .filter(e => !seenTypeIds.has(e.typeId) && seenTypeIds.add(e.typeId))
        .map(e => CORE_RESOURCE_TYPES.find(t => t.id === e.typeId))
        .filter(Boolean);
      return {
        ...r,
        typeName: types.map(t => t.name).join(" · ")
          || game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.unknownType"),
        typeIcon: types[0]?.icon ?? "fa-solid fa-question",
        selected: r.id === this._selectedResourceId
      };
    });
  }

  #buildSelectedResourceContext(currencies, isGM = true) {
    const resource = this.#syncSelectedResource();
    if (!resource) return null;

    const rawEntries  = getTypeEntries(resource);
    const subTypeMap  = this.#getSubTypeMap();
    const selectedSet = new Set(rawEntries.map(e => `${e.typeId}::${e.subTypeId ?? ""}`));

    const typeEntries = rawEntries.map((entry, index) => {
      const coreType = CORE_RESOURCE_TYPES.find(t => t.id === entry.typeId);
      const subType  = entry.subTypeId
        ? (subTypeMap[entry.typeId] ?? []).find(s => s.id === entry.subTypeId)
        : null;
      return {
        ...entry, index,
        typeIcon:    coreType?.icon ?? "fa-solid fa-question",
        typeName:    coreType?.name ?? entry.typeId,
        subTypeName: subType?.name ?? null
      };
    });

    const pickerGroups = CORE_RESOURCE_TYPES.map(t => {
      const allSubTypes   = subTypeMap[t.id] ?? [];
      const availSubTypes = allSubTypes
        .filter(s => !selectedSet.has(`${t.id}::${s.id}`))
        .map(s => ({ id: s.id, name: s.name }));
      const typeItselfAvailable = !selectedSet.has(`${t.id}::`);
      return { typeId: t.id, name: t.name, icon: t.icon, typeItselfAvailable, subTypes: availSubTypes };
    }).filter(g => g.typeItselfAvailable || g.subTypes.length > 0);

    const typeIds = [...new Set(rawEntries.map(e => e.typeId))];
    const sections = typeIds.map(id => {
      const isCurrencyTest = id === RESOURCE_TYPE_IDS.CURRENCY_TEST;
      const isInn = id === RESOURCE_TYPE_IDS.INN;
      const expenses = isCurrencyTest
        ? (resource.typeData?.expenses ?? []).map(e => {
            const c = currencies.find(x => x.id === e.currencyId);
            return { ...e, costLabel: `${e.amount} ${c?.abbreviation ?? "?"}` };
          })
        : [];
      return {
        typeId: id, isInn, isCurrencyTest,
        isOther: !isInn && !isCurrencyTest,
        expenses,
        innData: isInn ? this.#buildInnData(resource, currencies, isGM) : null
      };
    });

    return {
      id: resource.id,
      name: resource.name,
      isGM,
      typeEntries,
      pickerGroups,
      hasAvailableTypes: isGM && pickerGroups.length > 0,
      sections,
      hasDetails: sections.length > 0
    };
  }

  #buildInnData(resource, currencies, isGM = true) {
    const innRaw    = resource.typeData?.inn ?? { lodgings: [], ledger: [] };
    const { daysPerWeek, hoursPerDay } = getWorldTimeConfig();
    const worldTime = game.time.worldTime;

    const lodgings = (innRaw.lodgings ?? []).map(l => {
      const dayCurr     = currencies.find(c => c.id === l.pricePerDay?.currencyId);
      const dayLabel    = `${l.pricePerDay?.amount ?? 0} ${dayCurr?.abbreviation ?? "?"}`;
      const weeklyAmt   = l.pricePerWeek?.amount ?? ((l.pricePerDay?.amount ?? 0) * daysPerWeek);
      const weekCurr    = l.pricePerWeek ? currencies.find(c => c.id === l.pricePerWeek.currencyId) : dayCurr;
      const weekLabel   = `${weeklyAmt} ${weekCurr?.abbreviation ?? "?"}`;
      return { ...l, pricePerDayLabel: dayLabel, pricePerWeekLabel: weekLabel };
    });

    const allLedger = innRaw.ledger ?? [];
    const visibleLedger = isGM
      ? allLedger
      : allLedger.filter(e => e.actorId === game.user.character?.id);

    const ledger = visibleLedger.map(e => {
      const remaining = e.expiresAt - worldTime;
      const isExpired = remaining <= 0;
      const timeRemainingLabel = isExpired
        ? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.expired")
        : (() => { const { totalDays, hour, minute } = secondsToComponents(remaining); return `${totalDays}d ${hour}h ${String(minute).padStart(2, "0")}m`; })();
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

  // ------------------------------------------------------------------ render

  async _onRender(context, options) {
    await super._onRender(context, options);

    if (game.user.isGM) {
      this.element.querySelector('[name="cityName"]')?.addEventListener("change", e => {
        canvas.scene?.setFlag(MODULE_ID, FLAGS.CITY_NAME, e.target.value);
      });
      this.element.querySelector('[name="cityType"]')?.addEventListener("change", e => {
        canvas.scene?.setFlag(MODULE_ID, FLAGS.CITY_TYPE, e.target.value);
      });
      this.element.querySelector('[name="resourceName"]')?.addEventListener("change", async e => {
        const resource = this.#syncSelectedResource();
        if (!resource) return;
        const name = e.target.value.trim();
        if (!name) return;
        resource.name = name;
        await this.#saveResourceData(resource);
      });
      this.#setupTypePicker();
    }

    if (!this._sceneUpdateHook) {
      this._sceneUpdateHook = Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas.scene?.id) return;
        if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.RESOURCES}`)) return;
        this.render({ parts: ["content"] });
      });
    }
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#pickerAbort?.abort();
    this.#pickerDropdown?.remove();
    this.#pickerDropdown = null;
    if (this._sceneUpdateHook) {
      Hooks.off("updateScene", this._sceneUpdateHook);
      this._sceneUpdateHook = null;
    }
  }

  #setupTypePicker() {
    this.#pickerAbort?.abort();
    this.#pickerAbort = new AbortController();
    const { signal } = this.#pickerAbort;

    this.#pickerDropdown?.remove();
    this.#pickerDropdown = null;

    const trigger  = this.element.querySelector(".resource-add-type-trigger");
    const dropdown = trigger?.querySelector(".resource-type-picker-dropdown");
    if (!trigger || !dropdown) return;

    document.body.appendChild(dropdown);
    this.#pickerDropdown = dropdown;

    trigger.querySelector(".add-type-btn")?.addEventListener("click", e => {
      e.stopPropagation();
      const rect = trigger.getBoundingClientRect();
      dropdown.style.top  = `${rect.bottom + 2}px`;
      dropdown.style.left = `${rect.left}px`;
      dropdown.classList.toggle("is-open");
      dropdown.querySelector(".type-picker-filter")?.focus();
    }, { signal });

    document.addEventListener("click", () => dropdown.classList.remove("is-open"), { signal });
    dropdown.addEventListener("click", e => e.stopPropagation(), { signal });

    const filterInput = dropdown.querySelector(".type-picker-filter");
    filterInput?.addEventListener("input", () => {
      const q = filterInput.value.trim().toLowerCase();
      dropdown.querySelectorAll(".picker-group").forEach(group => {
        const typeItem  = group.querySelector(".picker-type-item");
        const typeText  = (typeItem?.textContent ?? "").toLowerCase();
        const typeMatch = !q || typeText.includes(q);
        let anySubMatch = false;
        group.querySelectorAll(".picker-subtype-item").forEach(item => {
          const subMatch = typeMatch || item.textContent.toLowerCase().includes(q);
          item.hidden = !subMatch;
          if (subMatch) anySubMatch = true;
        });
        if (typeItem) typeItem.hidden = !typeMatch;
        group.hidden = !typeMatch && !anySubMatch;
      });
    }, { signal });

    dropdown.querySelectorAll(".picker-item").forEach(item => {
      item.addEventListener("click", async () => {
        const resource = this.#syncSelectedResource();
        if (!resource) return;
        const typeId   = item.dataset.typeId;
        const subTypeId = item.dataset.subTypeId || null;
        const entries  = getTypeEntries(resource);
        entries.push({ typeId, subTypeId });
        resource.typeEntries = entries;
        if (typeId === RESOURCE_TYPE_IDS.INN && !resource.typeData?.inn) {
          const subType = (this.#getSubTypeMap()[RESOURCE_TYPE_IDS.INN] ?? []).find(s => s.id === subTypeId);
          resource.typeData ??= {};
          resource.typeData.inn = {
            lodgings: foundry.utils.deepClone(subType?.typeData?.lodgings ?? []),
            ledger: [],
            menu: foundry.utils.deepClone(subType?.typeData?.menu ?? { courses: [] })
          };
        }
        dropdown.classList.remove("is-open");
        await this.#saveResourceData(resource);
      }, { signal });
    });
  }

  // ------------------------------------------------------------------ helpers

  #getSubTypeMap() {
    const raw = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    return Array.isArray(raw) ? {} : (raw ?? {});
  }

  #syncSelectedResource() {
    if (!this._selectedResourceId) return null;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    return resources.find(r => r.id === this._selectedResourceId) ?? null;
  }

  async #saveResourceData(updatedResource) {
    const scene = canvas.scene;
    if (!scene) return;
    if (game.user.isGM) {
      const resources = scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
      const index = resources.findIndex(r => r.id === updatedResource.id);
      if (index === -1) return;
      resources[index] = updatedResource;
      await scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
      this.render({ parts: ["content"] });
    } else {
      // Players lack scene write permission — route through the active GM.
      // The updateScene hook on all clients re-renders this app once the GM saves.
      game.socket.emit(SOCKET_CHANNEL, {
        type: SOCKET_TYPES.SAVE_RESOURCE,
        sceneId: scene.id,
        resource: updatedResource
      });
    }
  }

  async #saveInnData(innData) {
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    resource.typeData ??= {};
    resource.typeData.inn = innData;
    await this.#saveResourceData(resource);
  }

  // ------------------------------------------------------------------ left pane actions

  static async #onAddResource() {
    if (!game.user.isGM) return;
    const result = await ResourceEditApp.open({});
    if (!result) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    resources.push(result);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this._selectedResourceId = result.id;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteResource(event, target) {
    if (!game.user.isGM) return;
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const index = resources.findIndex(r => r.id === id);
    if (index === -1) return;
    resources.splice(index, 1);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    if (this._selectedResourceId === id) this._selectedResourceId = null;
    this.render({ parts: ["content"] });
  }

  static async #onToggleDiscovered(event, target) {
    if (!game.user.isGM) return;
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

  static #onSelectResource(event, target) {
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id || id === this._selectedResourceId) return;
    this._selectedResourceId = id;
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

  // ------------------------------------------------------------------ right pane actions

  static async #onRemoveTypeEntry(event, target) {
    if (!game.user.isGM) return;
    const index = parseInt(target.dataset.entryIndex);
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const entries = getTypeEntries(resource);
    entries.splice(index, 1);
    resource.typeEntries = entries;
    await this.#saveResourceData(resource);
  }

  static async #onAddLodging() {
    if (!game.user.isGM) return;
    const result = await LodgingEditApp.open({});
    if (!result) return;
    result.id ??= foundry.utils.randomID();
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.lodgings.push(result);
    await this.#saveInnData(innData);
  }

  static async #onEditLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    const index = innData.lodgings.findIndex(l => l.id === lodgingId);
    if (index === -1) return;
    const result = await LodgingEditApp.open(innData.lodgings[index]);
    if (!result) return;
    innData.lodgings[index] = result;
    await this.#saveInnData(innData);
  }

  static async #onDeleteLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.lodgings = innData.lodgings.filter(l => l.id !== lodgingId);
    await this.#saveInnData(innData);
  }

  static async #onRentLodging(event, target) {
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const resource = this.#syncSelectedResource();
    const lodging  = resource?.typeData?.inn?.lodgings?.find(l => l.id === lodgingId);
    if (!lodging) return;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];

    const rental = await LodgingRentalDialog.open(lodging, currencies);
    if (!rental) return;

    const paymentResult = await PurchaseDialog.open({
      expense: rental.expense, currencies, mode: currencyConfig.mode ?? "loose"
    });
    if (!paymentResult) return;

    const purchasedAt = game.time.worldTime;
    const entry = {
      id: foundry.utils.randomID(),
      lodgingId: lodging.id, lodgingName: lodging.name, beds: lodging.beds,
      actorId: rental.actorId, actorName: rental.actorName,
      purchasedAt, durationSeconds: rental.durationSeconds,
      expiresAt: purchasedAt + rental.durationSeconds
    };

    const innData = foundry.utils.deepClone(resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.ledger.push(entry);
    await this.#saveInnData(innData);
  }

  static async #onDismissLedgerEntry(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.entryId;
    if (!entryId) return;
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.ledger = innData.ledger.filter(e => e.id !== entryId);
    await this.#saveInnData(innData);
  }

  static async #onConfigureMenu() {
    if (!game.user.isGM) return;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const inn = resource.typeData?.inn ?? { lodgings: [], ledger: [], menu: { courses: [] } };
    await MenuConfigApp.open(
      inn.menu ?? { courses: [] },
      async (updatedMenu) => {
        const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
        innData.menu = updatedMenu;
        await this.#saveInnData(innData);
      }
    );
  }

  static async #onRefreshCourse(event, target) {
    if (!game.user.isGM) return;
    const courseId = target.dataset.courseId;
    if (!courseId) return;
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
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
    const resource = this.#syncSelectedResource();
    const inn = resource?.typeData?.inn;
    if (!inn) return;
    const course = (inn.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course) return;
    const allItems = course.mode === "random" ? (course.drawnItems ?? []) : (course.items ?? []);
    const item = allItems.find(i => i.id === itemId);
    if (!item) return;
    const resolvedPrice = item.price ?? course.price;
    if (!resolvedPrice) return;

    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];
    const expense = { id: item.id, name: item.name, currencyId: resolvedPrice.currencyId, amount: resolvedPrice.amount };

    const paid = await PurchaseDialog.open({ expense, currencies, mode: currencyConfig.mode ?? "loose" });
    if (!paid) return;

    // Grant the linked Foundry item to the actor if configured
    // NOTE: This pattern (purchase + item grant) will be shared with future Merchant resource type
    if (item.itemId) {
      const actor  = game.actors.get(paid.actorId);
      const source = await fromUuid(item.itemId).catch(() => null);
      if (actor && source) await actor.createEmbeddedDocuments("Item", [source.toObject()]);
    }
  }
}
