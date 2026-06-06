import { MODULE_ID, FLAGS, SETTINGS, RESOURCE_TYPE_IDS, CORE_RESOURCE_TYPES, getTypeEntries } from "../constants.js";
import { ResourceEditApp } from "./resource-edit-app.js";
import { CurrencyTestConfigApp } from "./currency-test-config.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { cartManager } from "./cart-manager.js";
import { CartApp } from "./cart-app.js";
import { MenuConfigApp } from "./inn/menu-config-app.js";
import { TemplateRestoreDialog } from "./inn/template-restore-dialog.js";
import { PurchaseDialog } from "./purchase-dialog.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { readItemName, readItemPrice } from "../utils/item-utils.js";
import { MerchantItemEditApp } from "./merchant-item-edit-app.js";
import { SOCKET_CHANNEL, SOCKET_TYPES } from "../socket.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CityManageApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _selectedResourceId = null;
  _activeTab = null;
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
      switchTab:          CityManageApp.#onSwitchTab,
      deleteTypeEntry:    CityManageApp.#onDeleteTypeEntry,
      removeTypeEntry:    CityManageApp.#onRemoveTypeEntry,
      addLodging:         CityManageApp.#onAddLodging,
      editLodging:        CityManageApp.#onEditLodging,
      deleteLodging:      CityManageApp.#onDeleteLodging,
      rentLodging:        CityManageApp.#onRentLodging,
      dismissLedgerEntry: CityManageApp.#onDismissLedgerEntry,
      configureMenu:        CityManageApp.#onConfigureMenu,
      refreshCourse:        CityManageApp.#onRefreshCourse,
      buyMenuItem:          CityManageApp.#onBuyMenuItem,
      restoreFromTemplate:  CityManageApp.#onRestoreFromTemplate,
      addMerchantItem:        CityManageApp.#onAddMerchantItem,
      deleteMerchantItem:     CityManageApp.#onDeleteMerchantItem,
      editMerchantItem:       CityManageApp.#onEditMerchantItem,
      addManualInventoryItem: CityManageApp.#onAddManualInventoryItem
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
    const activeTab = this._activeTab ?? typeIds[0] ?? null;
    const tabs = typeIds.map(id => {
      const coreType       = CORE_RESOURCE_TYPES.find(t => t.id === id);
      const isCurrencyTest = id === RESOURCE_TYPE_IDS.CURRENCY_TEST;
      const isInn          = id === RESOURCE_TYPE_IDS.INN;
      const isMerchant     = id === RESOURCE_TYPE_IDS.MERCHANT;
      const firstEntry     = rawEntries.find(e => e.typeId === id);
      const subType        = firstEntry?.subTypeId
        ? (subTypeMap[id] ?? []).find(s => s.id === firstEntry.subTypeId) ?? null
        : null;
      const expenses = isCurrencyTest
        ? (resource.typeData?.expenses ?? []).map(e => {
            const c = currencies.find(x => x.id === e.currencyId);
            return { ...e, costLabel: `${e.amount} ${c?.abbreviation ?? "?"}` };
          })
        : [];
      return {
        id, active: id === activeTab,
        name:        coreType?.name ?? id,
        subTypeName: subType?.name ?? null,
        icon:        coreType?.icon ?? "fa-solid fa-question",
        typeId: id, isInn, isCurrencyTest, isMerchant,
        isOther: !isInn && !isCurrencyTest && !isMerchant,
        expenses,
        innData:      isInn      ? this.#buildInnData(resource, currencies, isGM)      : null,
        merchantData: isMerchant ? this.#buildMerchantData(resource, currencies, isGM) : null
      };
    });

    const innTemplate = isGM ? this.#getTemplateForResource(resource) : null;
    return {
      id: resource.id,
      name: resource.name,
      isGM,
      pickerGroups,
      hasAvailableTypes: isGM && pickerGroups.length > 0,
      hasInnTemplate:    !!innTemplate,
      tabs,
      hasTabs:         tabs.length > 0,
      hasMultipleTabs: tabs.length > 1,
      hasDetails:      tabs.length > 0
    };
  }

  #getTemplateForResource(resource) {
    const entry = getTypeEntries(resource).find(e => e.typeId === RESOURCE_TYPE_IDS.INN);
    if (!entry?.subTypeId) return null;
    const subTypes = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    return (subTypes[RESOURCE_TYPE_IDS.INN] ?? []).find(t => t.id === entry.subTypeId) ?? null;
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
      const avail       = l.availability ?? null;
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

    // Wire merchant drop zone
    const dropZone = this.element.querySelector(".merchant-drop-zone");
    if (dropZone) {
      dropZone.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; dropZone.classList.add("drag-over"); });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
      dropZone.addEventListener("drop",      e => { dropZone.classList.remove("drag-over"); this.#onMerchantDrop(e); });
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
            lodgings: foundry.utils.deepClone(subType?.typeData?.lodgings ?? []).map(l => ({
              ...l, templateItemId: l.id, overridden: false
            })),
            ledger: [],
            menu: {
              courses: foundry.utils.deepClone(subType?.typeData?.menu?.courses ?? []).map(c => ({
                ...c, templateItemId: c.id, overridden: false
              }))
            }
          };
        }
        if (typeId === RESOURCE_TYPE_IDS.MERCHANT && !resource.typeData?.merchant) {
          resource.typeData ??= {};
          resource.typeData.merchant = { inventory: [] };
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

  #buildMerchantData(resource, currencies, isGM = true) {
    const inventory = (resource.typeData?.merchant?.inventory ?? []).map(item => {
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
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    resource.typeData ??= {};
    resource.typeData.merchant = merchantData;
    await this.#saveResourceData(resource);
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

    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const merchant = foundry.utils.deepClone(resource.typeData?.merchant ?? { inventory: [] });
    merchant.inventory.push({ id: foundry.utils.randomID(), name, price, itemId: item.uuid, quantity: null });
    resource.typeData ??= {};
    resource.typeData.merchant = merchant;
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
    this._activeTab = null;
    this.render({ parts: ["content"] });
  }

  static #onSwitchTab(event, target) {
    this._activeTab = target.dataset.tabId;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteTypeEntry(event, target) {
    if (!game.user.isGM) return;
    const typeId = target.dataset.typeId;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const coreType = CORE_RESOURCE_TYPES.find(t => t.id === typeId);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.removeTypeTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.resource.removeTypeConfirm", { type: coreType?.name ?? typeId, resource: resource.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    resource.typeEntries = getTypeEntries(resource).filter(e => e.typeId !== typeId);
    if (resource.typeData?.[typeId]) delete resource.typeData[typeId];
    if (this._activeTab === typeId) this._activeTab = null;
    await this.#saveResourceData(resource);
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
    const resource = this.#syncSelectedResource();
    const innData  = foundry.utils.deepClone(resource?.typeData?.inn ?? { lodgings: [], ledger: [] });
    const index    = innData.lodgings.findIndex(l => l.id === lodgingId);
    if (index === -1) return;
    const lodging = innData.lodgings[index];
    const template = lodging.templateItemId ? this.#getTemplateForResource(resource) : null;
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
    cartManager.addLodging({
      sceneId: canvas.scene?.id,
      resourceId: resource.id,
      resourceName: resource.name,
      lodging
    });
    CartApp.open();
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
    const inn      = resource.typeData?.inn ?? { lodgings: [], ledger: [], menu: { courses: [] } };
    const template = this.#getTemplateForResource(resource);
    await MenuConfigApp.open(
      inn.menu ?? { courses: [] },
      async (updatedMenu) => {
        const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
        innData.menu = updatedMenu;
        await this.#saveInnData(innData);
      },
      template
    );
  }

  static async #onRestoreFromTemplate() {
    if (!game.user.isGM) return;
    const resource = this.#syncSelectedResource();
    const template = this.#getTemplateForResource(resource);
    if (!resource || !template) return;
    const innData = foundry.utils.deepClone(resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    await TemplateRestoreDialog.open(innData, template, async (updatedInn) => {
      await this.#saveInnData(updatedInn);
    });
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
    cartManager.addMenuItem({
      sceneId: canvas.scene?.id,
      resourceId: resource.id,
      resourceName: resource.name,
      course,
      item
    });
    CartApp.open();
  }

  static async #onAddMerchantItem(event, target) {
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const resource = this.#syncSelectedResource();
    const item = (resource?.typeData?.merchant?.inventory ?? []).find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMerchantItem({
      sceneId: canvas.scene?.id,
      resourceId: resource.id,
      resourceName: resource.name,
      item
    });
    CartApp.open();
  }

  static async #onDeleteMerchantItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const merchant = foundry.utils.deepClone(resource.typeData?.merchant ?? { inventory: [] });
    merchant.inventory = merchant.inventory.filter(i => i.id !== itemId);
    await this.#saveMerchantData(merchant);
  }

  static async #onEditMerchantItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    const resource = this.#syncSelectedResource();
    const merchant = foundry.utils.deepClone(resource?.typeData?.merchant ?? { inventory: [] });
    const existing = merchant.inventory.find(i => i.id === itemId);
    if (!existing) return;
    const result = await MerchantItemEditApp.open(existing);
    if (!result) return;
    const idx = merchant.inventory.findIndex(i => i.id === itemId);
    if (idx !== -1) merchant.inventory[idx] = result;
    await this.#saveMerchantData(merchant);
  }

  static async #onAddManualInventoryItem() {
    if (!game.user.isGM) return;
    const result = await MerchantItemEditApp.open({});
    if (!result) return;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const merchant = foundry.utils.deepClone(resource.typeData?.merchant ?? { inventory: [] });
    merchant.inventory.push(result);
    resource.typeData ??= {};
    resource.typeData.merchant = merchant;
    await this.#saveResourceData(resource);
  }
}
