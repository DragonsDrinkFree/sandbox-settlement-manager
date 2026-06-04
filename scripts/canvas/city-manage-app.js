import { MODULE_ID, FLAGS, SETTINGS, RESOURCE_TYPE_IDS, CORE_RESOURCE_TYPES, getTypeEntries } from "../constants.js";
import { ResourceEditApp } from "./resource-edit-app.js";
import { CurrencyTestConfigApp } from "./currency-test-config.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { LodgingRentalDialog } from "./inn/lodging-rental-dialog.js";
import { PurchaseDialog } from "./purchase-dialog.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { SOCKET_CHANNEL, SOCKET_TYPES } from "../socket.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CityManageApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _selectedResourceId = null;
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
      dismissLedgerEntry: CityManageApp.#onDismissLedgerEntry
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/city-manage.hbs` }
  };

  // ------------------------------------------------------------------ context

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const scene = canvas.scene;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];

    context.cityName     = scene?.getFlag(MODULE_ID, FLAGS.CITY_NAME) ?? "";
    context.cityTypes    = game.settings.get(MODULE_ID, SETTINGS.CITY_TYPES)
      .map(t => ({ value: t.name, label: t.name }));
    context.selectedType = scene?.getFlag(MODULE_ID, FLAGS.CITY_TYPE) ?? "";
    context.resources    = this.#enrichResources();
    context.selectedResource = this.#buildSelectedResourceContext(currencies);
    return context;
  }

  #enrichResources() {
    const instances = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
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

  #buildSelectedResourceContext(currencies) {
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
        innData: isInn ? this.#buildInnData(resource, currencies) : null
      };
    });

    return {
      id: resource.id,
      name: resource.name,
      typeEntries,
      pickerGroups,
      hasAvailableTypes: pickerGroups.length > 0,
      sections,
      hasDetails: sections.length > 0
    };
  }

  #buildInnData(resource, currencies) {
    const innRaw    = resource.typeData?.inn ?? { lodgings: [], ledger: [] };
    const { daysPerWeek } = getWorldTimeConfig();
    const worldTime = game.time.worldTime;

    const lodgings = (innRaw.lodgings ?? []).map(l => {
      const dayCurr     = currencies.find(c => c.id === l.pricePerDay?.currencyId);
      const dayLabel    = `${l.pricePerDay?.amount ?? 0} ${dayCurr?.abbreviation ?? "?"}`;
      const weeklyAmt   = l.pricePerWeek?.amount ?? ((l.pricePerDay?.amount ?? 0) * daysPerWeek);
      const weekCurr    = l.pricePerWeek ? currencies.find(c => c.id === l.pricePerWeek.currencyId) : dayCurr;
      const weekLabel   = `${weeklyAmt} ${weekCurr?.abbreviation ?? "?"}`;
      return { ...l, pricePerDayLabel: dayLabel, pricePerWeekLabel: weekLabel };
    });

    const ledger = (innRaw.ledger ?? []).map(e => {
      const remaining = e.expiresAt - worldTime;
      const isExpired = remaining <= 0;
      const timeRemainingLabel = isExpired
        ? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.expired")
        : (() => { const { totalDays, hour, minute } = secondsToComponents(remaining); return `${totalDays}d ${hour}h ${String(minute).padStart(2, "0")}m`; })();
      return { ...e, isExpired, timeRemainingLabel };
    });

    return { lodgings, ledger, isGM: true };
  }

  // ------------------------------------------------------------------ render

  async _onRender(context, options) {
    await super._onRender(context, options);
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

  async _onClose(options) {
    await super._onClose(options);
    this.#pickerAbort?.abort();
    this.#pickerDropdown?.remove();
    this.#pickerDropdown = null;
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
            ledger: []
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
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const index = resources.findIndex(r => r.id === updatedResource.id);
    if (index === -1) return;
    resources[index] = updatedResource;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this.render({ parts: ["content"] });
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
    const result = await ResourceEditApp.open({});
    if (!result) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    resources.push(result);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this._selectedResourceId = result.id;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteResource(event, target) {
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
    const index = parseInt(target.dataset.entryIndex);
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const entries = getTypeEntries(resource);
    entries.splice(index, 1);
    resource.typeEntries = entries;
    await this.#saveResourceData(resource);
  }

  static async #onAddLodging() {
    const result = await LodgingEditApp.open({});
    if (!result) return;
    result.id ??= foundry.utils.randomID();
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.lodgings.push(result);
    await this.#saveInnData(innData);
  }

  static async #onEditLodging(event, target) {
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

    // GM has scene write permission — no socket needed here
    const innData = foundry.utils.deepClone(resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.ledger.push(entry);
    await this.#saveInnData(innData);
  }

  static async #onDismissLedgerEntry(event, target) {
    const entryId = target.dataset.entryId;
    if (!entryId) return;
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.ledger = innData.ledger.filter(e => e.id !== entryId);
    await this.#saveInnData(innData);
  }
}
