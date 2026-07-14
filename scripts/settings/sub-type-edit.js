import { MODULE_ID, SETTINGS, LOCATION_TYPE_IDS, CORE_LOCATION_TYPES } from "../constants.js";
import { CourseEditApp } from "../canvas/inn/course-edit-app.js";
import { getWorldTimeConfig } from "../time/world-time.js";
import { readItemName, readItemPrice } from "../utils/item-utils.js";
import { costInStandard, getStandardCurrency } from "../utils/currency-utils.js";
import { MerchantSortDialog } from "./merchant-sort-dialog.js";
import { CompendiumItemPickerApp } from "./compendium-item-picker-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/** Reorder a merchant inventory by an ordered sort spec `[{ key, dir }, …]`. Returns a new array. */
function sortMerchantInventory(inventory, spec, currencies) {
  const typeKey  = it => (CONFIG.Item?.typeLabels?.[it.itemType] ?? it.itemType ?? "").toLowerCase();
  const nameKey  = it => (it.name ?? "").toLowerCase();
  const priceKey = it => costInStandard(it.price ?? { amount: 0, currencyId: "" }, currencies);
  return [...inventory].sort((a, b) => {
    for (const { key, dir } of spec) {
      let cmp = 0;
      if (key === "itemType") cmp = typeKey(a).localeCompare(typeKey(b));
      else if (key === "itemName") cmp = nameKey(a).localeCompare(nameKey(b));
      else if (key === "price") cmp = priceKey(a) - priceKey(b);
      if (dir === "desc") cmp = -cmp;
      if (cmp) return cmp;
    }
    return 0;
  });
}

export class SubTypeEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _subType;
  _typeId = null;
  _selectedType = null;   // tracks the templateType <select> across re-renders (add-template flow)
  _lodgings = [];
  _menu = { courses: [] };
  _templateInventory = [];
  _merchantTab = "inventory";
  _purchasingProfile = [];
  _stockType = null;        // tracks merchantStockType <select> across re-renders
  _restockFrequency = null; // tracks merchantRestockFrequency <select> across re-renders
  _inventorySort = [{ key: "itemType", dir: "asc" }, { key: "itemName", dir: "asc" }]; // last-used merchant inventory sort spec
  _locationMode = false;   // true when editing a single location entry instead of a shared template
  _locationName = "";      // owning location's name (location mode, for the title)
  _entryBase    = null;    // deep clone of the original location entry — runtime fields preserved on save

  constructor(subType, options = {}) {
    super(options);
    this._subType = subType;
  }

  get title() {
    if (this._locationMode) {
      return game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.locationType.subType.editLocationTitle", { name: this._locationName });
    }
    const key = this._subType?.name
      ? "SANDBOX_SETTLEMENT_MANAGER.locationType.subType.editTitle"
      : "SANDBOX_SETTLEMENT_MANAGER.locationType.subType.addTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-sub-type-edit`,
    tag: "form",
    form: { handler: SubTypeEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 800 },
    actions: {
      addLodging:                 SubTypeEditApp.#onAddLodging,
      deleteLodging:              SubTypeEditApp.#onDeleteLodging,
      addCourse:                  SubTypeEditApp.#onAddCourse,
      editCourse:                 SubTypeEditApp.#onEditCourse,
      deleteCourse:               SubTypeEditApp.#onDeleteCourse,
      copyCoursesFromTemplate:    SubTypeEditApp.#onCopyCoursesFromTemplate,
      importFromRollTable:        SubTypeEditApp.#onImportFromRollTable,
      addTemplateInventoryItem:   SubTypeEditApp.#onAddTemplateInventoryItem,
      deleteTemplateInventoryItem: SubTypeEditApp.#onDeleteTemplateInventoryItem,
      sortInventory:              SubTypeEditApp.#onSortInventory,
      importFromCompendium:       SubTypeEditApp.#onImportFromCompendium,
      switchMerchantTab:          SubTypeEditApp.#onSwitchMerchantTab,
      addPurchasingRule:          SubTypeEditApp.#onAddPurchasingRule,
      removePurchasingRule:       SubTypeEditApp.#onRemovePurchasingRule,
      cancel:                     SubTypeEditApp.#onCancel
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/sub-type-edit.hbs`, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(subType = {}, typeId = null) {
    return new Promise(resolve => {
      const app = new SubTypeEditApp(foundry.utils.deepClone(subType));
      app._typeId             = typeId;
      app._lodgings           = foundry.utils.deepClone(subType.typeData?.lodgings ?? []);
      app._menu               = foundry.utils.deepClone(subType.typeData?.menu ?? { courses: [] });
      app._templateInventory  = foundry.utils.deepClone(subType.typeData?.merchant?.inventory ?? []);
      app._purchasingProfile  = foundry.utils.deepClone(subType.typeData?.merchant?.purchasingProfile ?? []);
      app._resolve  = resolve;
      app.render(true);
    });
  }

  /**
   * Open the editor scoped to a single location entry (a "single-use template") instead of a shared
   * template. Loads working data from the location's `typeData[entryId]` shape (which differs from the
   * template shape) and resolves with an entry object that merges the edited authored fields back onto
   * the original entry — preserving runtime fields (per-item quantity, lastRestocked, buybackItems,
   * ledger, deposits, loans, _templateValues). The caller persists the result to the scene flag.
   * Resolves with the updated entry, or null if cancelled.
   */
  static async openForEntry(typeId, entryData = {}, { locationName = "" } = {}) {
    // Build a synthetic subType whose typeData mirrors the template shape _prepareContext expects,
    // so the merchant/bank display logic works unchanged.
    const syntheticTypeData = {};
    if (typeId === LOCATION_TYPE_IDS.BANK) {
      syntheticTypeData.bank = {
        doesExchange:    entryData.doesExchange ?? false,
        exchangeFee:     entryData.exchangeFee  ?? 0,
        depositSettings: entryData.depositSettings ?? {}
      };
    }
    if (typeId === LOCATION_TYPE_IDS.MERCHANT) {
      syntheticTypeData.merchant = { stockType: entryData.stockType, restockFrequency: entryData.restockFrequency };
    }
    return new Promise(resolve => {
      const app = new SubTypeEditApp({ name: locationName, typeData: syntheticTypeData });
      app._typeId            = typeId;
      app._locationMode      = true;
      app._locationName      = locationName;
      app._entryBase         = foundry.utils.deepClone(entryData);
      // Working arrays loaded from the ENTRY shape (inventory/lodgings/etc. live at the entry root).
      app._lodgings          = foundry.utils.deepClone(entryData.lodgings ?? []);
      app._menu              = foundry.utils.deepClone(entryData.menu ?? { courses: [] });
      app._templateInventory = foundry.utils.deepClone(entryData.inventory ?? []);
      app._purchasingProfile = foundry.utils.deepClone(entryData.purchasingProfile ?? []);
      app._stockType         = entryData.stockType ?? null;
      app._restockFrequency  = entryData.restockFrequency ?? null;
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const isInn             = this._typeId === LOCATION_TYPE_IDS.INN;
    const isMerchant        = this._typeId === LOCATION_TYPE_IDS.MERCHANT;
    const isBank            = this._typeId === LOCATION_TYPE_IDS.BANK;
    const showTypeSelect    = !this._typeId;
    const showInnSections     = isInn || showTypeSelect;
    const showMerchantSection = isMerchant || showTypeSelect;
    const showBankSection     = isBank || showTypeSelect;
    const merchantData     = this._subType.typeData?.merchant ?? {};
    const stockType        = this._stockType        ?? merchantData.stockType        ?? "percent";
    const restockFrequency = this._restockFrequency ?? merchantData.restockFrequency ?? "weekly";
    const isXInSix         = stockType === "x-in-6";

    let lodgings = [];
    let currencies = [];
    let courses = [];
    let templateInventory = [];
    if (showInnSections || showMerchantSection || showBankSection) {
      const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
      currencies = currencyConfig.currencies ?? [];
      const defaultCurrencyId = getStandardCurrency(currencies)?.id ?? "";
      if (showInnSections) {
        lodgings = this._lodgings.map(l => ({
          ...l,
          autoWeekly:   !l.pricePerWeek,
          pricePerDay:  l.pricePerDay  ?? { currencyId: defaultCurrencyId, amount: 0 },
          pricePerWeek: l.pricePerWeek ?? { currencyId: defaultCurrencyId, amount: 0 }
        }));
        courses = (this._menu.courses ?? []).map((c, i) => ({
          name:      c.name,
          index:     i,
          isRandom:  c.mode === "random",
          itemCount: (c.mode === "random" ? (c.pool ?? []) : (c.items ?? [])).length
        }));
      }
      if (showMerchantSection) {
        templateInventory = await Promise.all(this._templateInventory.map(async item => {
          const entry = {
            ...item,
            price: item.price ?? { currencyId: defaultCurrencyId, amount: 0 },
            enrichedName: item.itemId
              ? await (foundry.applications?.ux?.TextEditor ?? TextEditor).enrichHTML(`@UUID[${item.itemId}]{${item.name}}`, { async: true })
              : null
          };
          if (isXInSix) {
            const v   = parseInt(item.stockAvailability);
            const cur = (Number.isInteger(v) && v >= 1 && v <= 6) ? v : 6;
            entry.xin6Options = [1, 2, 3, 4, 5, 6].map(n => ({
              value: n,
              label: game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.merchant.xInSixOption", { n }),
              selected: n === cur
            }));
          }
          return entry;
        }));
      }
    }
    const settlementTypes = game.settings.get(MODULE_ID, SETTINGS.SETTLEMENT_TYPES) ?? [];
    const bankData     = this._subType.typeData?.bank ?? {};

    const rawTypes = game.system.documentTypes?.Item ?? [];
    const systemItemTypes = (Array.isArray(rawTypes) ? rawTypes : Object.keys(rawTypes))
      .filter(t => t !== "base")
      .map(t => ({ value: t, label: CONFIG.Item?.typeLabels?.[t] ?? t }));

    const buybackTypeOptions = [
      { value: "player", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.buybackPlayer") },
      { value: "full",   label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.buybackFull") }
    ];

    return {
      subType: this._subType,
      locationMode: this._locationMode,
      locationName: this._locationName,
      isInn,
      isMerchant,
      isBank,
      showTypeSelect,
      showInnSections,
      showMerchantSection,
      showBankSection,
      bankData,
      showTypeSpecificSections: showInnSections || showMerchantSection || showBankSection,
      coreTypes: CORE_LOCATION_TYPES,
      selectedType: this._selectedType,
      lodgings,
      currencies,
      courses,
      templateInventory,
      settlementTypes,
      stockType,
      restockFrequency,
      isXInSix,
      merchantTab: this._merchantTab,
      purchasingProfile: this._purchasingProfile,
      systemItemTypes,
      buybackTypeOptions,
      buttons: [
        { type: "submit", icon: "fa-solid fa-save",   label: "Save" },
        { type: "button", action: "cancel", icon: "fa-solid fa-xmark", label: "SANDBOX_SETTLEMENT_MANAGER.dialog.cancel" }
      ]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
    if (!this._typeId) this.#wireTypeSelect();
    this.#wireWeeklyLinks();
    this.#wireMerchantDragDrop();

    // Switching stock type swaps the Availability field (number ↔ X-in-6 dropdown), so re-render.
    this.element.querySelector('[name="merchantStockType"]')?.addEventListener('change', () => {
      this.#syncSubTypeName();
      this.#syncLodgingsFromDOM();
      this.#syncTemplateInventoryFromDOM();
      this.render({ parts: ["form"] });
    });
  }

  #wireTypeSelect() {
    const sel = this.element.querySelector('[name="templateType"]');
    if (!sel) return;
    const innSection      = this.element.querySelector('.inn-only');
    const merchantSection = this.element.querySelector('.merchant-only');
    const bankSection     = this.element.querySelector('.bank-only');
    const toggle = () => {
      if (innSection)      innSection.hidden      = (sel.value !== LOCATION_TYPE_IDS.INN);
      if (merchantSection) merchantSection.hidden = (sel.value !== LOCATION_TYPE_IDS.MERCHANT);
      if (bankSection)     bankSection.hidden     = (sel.value !== LOCATION_TYPE_IDS.BANK);
    };
    sel.addEventListener('change', toggle);
    toggle();
  }

  #wireWeeklyLinks() {
    const { daysPerWeek } = getWorldTimeConfig();
    this.element.querySelectorAll('.lodging-table-row').forEach(row => {
      const stateBox = row.querySelector('[data-field="autoWeekly"]');
      const linkBtn  = row.querySelector('.link-toggle-btn');
      const dayAmt   = row.querySelector('[data-field="pricePerDayAmount"]');
      const dayCurr  = row.querySelector('[data-field="pricePerDayCurrencyId"]');
      const wkAmt    = row.querySelector('[data-field="pricePerWeekAmount"]');
      const wkCurr   = row.querySelector('[data-field="pricePerWeekCurrencyId"]');

      const applyState = () => {
        const linked = !!stateBox?.checked;
        linkBtn?.classList.toggle('is-linked', linked);
        if (wkAmt)  wkAmt.readOnly  = linked;
        if (wkCurr) wkCurr.disabled = linked;
        if (linked) {
          const amt = parseFloat(dayAmt?.value) || 0;
          if (wkAmt)              wkAmt.value  = (amt * (daysPerWeek ?? 7)).toFixed(2);
          if (wkCurr && dayCurr) wkCurr.value = dayCurr.value;
        }
      };

      applyState();

      linkBtn?.addEventListener('click', () => {
        if (stateBox) stateBox.checked = !stateBox.checked;
        applyState();
      });

      dayAmt?.addEventListener('input', () => {
        if (!stateBox?.checked) return;
        const amt = parseFloat(dayAmt.value) || 0;
        if (wkAmt) wkAmt.value = (amt * (daysPerWeek ?? 7)).toFixed(2);
      });

      dayCurr?.addEventListener('change', () => {
        if (!stateBox?.checked) return;
        if (wkCurr) wkCurr.value = dayCurr.value;
      });
    });
  }

  #syncLodgingsFromDOM() {
    const rows = this.element?.querySelectorAll('.lodging-table-row') ?? [];
    this._lodgings = [...rows].map(row => this.#rowToLodging(row));
  }

  #rowToLodging(row) {
    const autoWeekly   = !!row.querySelector('[data-field="autoWeekly"]')?.checked;
    const pdCurrencyId = row.querySelector('[data-field="pricePerDayCurrencyId"]')?.value ?? "";
    const avStr        = (row.querySelector('[data-field="availability"]')?.value ?? "").trim();
    const avInt        = parseInt(avStr);
    const id           = row.dataset.lodgingId || foundry.utils.randomID();
    // Merge onto the existing lodging (by id) so link metadata (templateItemId, _templateValues)
    // survives in location mode; authored fields below are overwritten from the DOM.
    const existing     = (this._lodgings ?? []).find(l => l.id === id) ?? {};
    return {
      ...existing,
      id,
      name:         (row.querySelector('[data-field="name"]')?.value ?? "").trim(),
      beds:         parseInt(row.querySelector('[data-field="beds"]')?.value) || 0,
      availability: (avStr !== "" && Number.isFinite(avInt)) ? avInt : null,
      pricePerDay: {
        currencyId: pdCurrencyId,
        amount:     parseFloat(row.querySelector('[data-field="pricePerDayAmount"]')?.value) || 0
      },
      pricePerWeek: autoWeekly ? null : {
        currencyId: row.querySelector('[data-field="pricePerWeekCurrencyId"]')?.value ?? pdCurrencyId,
        amount:     parseFloat(row.querySelector('[data-field="pricePerWeekAmount"]')?.value) || 0
      }
    };
  }

  #syncTemplateInventoryFromDOM() {
    const rows = this.element?.querySelectorAll('.merchant-inventory-row') ?? [];
    if (!rows.length && this._templateInventory.length) return;
    // Merge onto the existing item (by id) rather than rebuild, so link metadata (templateItemId,
    // _templateValues) and runtime fields (quantity) survive in location mode.
    const byId = new Map(this._templateInventory.map(it => [it.id, it]));
    this._templateInventory = [...rows].map(row => {
      const id = row.dataset.inventoryItemId || foundry.utils.randomID();
      return {
        ...(byId.get(id) ?? {}),
        id,
        name:             (row.querySelector('[data-field="name"]')?.value ?? "").trim(),
        itemId:           row.dataset.itemUuid ?? null,
        itemType:         row.dataset.itemType ?? null,
        minSettlementSize:      (row.querySelector('[data-field="minSettlementSize"]')?.value ?? "").trim(),
        stockAvailability: parseFloat(row.querySelector('[data-field="stockAvailability"]')?.value) || 100,
        stockFormula:     (row.querySelector('[data-field="stockFormula"]')?.value ?? "").trim(),
        price: {
          currencyId: row.querySelector('[data-field="priceCurrencyId"]')?.value ?? "",
          amount:     parseFloat(row.querySelector('[data-field="priceAmount"]')?.value) || 0
        }
      };
    });
  }

  /** Build a template inventory entry from an Item document. */
  #makeInventoryEntry(item, currencies) {
    return {
      id:                foundry.utils.randomID(),
      name:              readItemName(item),
      price:             readItemPrice(item, currencies),
      itemId:            item.uuid,
      itemType:          item.type ?? null,
      minSettlementSize: "",
      stockAvailability: 100,
      stockFormula:      ""
    };
  }

  /** Collect all Item documents in a folder, including nested subfolders. */
  #collectFolderItems(folder) {
    const folders = [folder, ...(folder.getSubfolders?.(true) ?? [])];
    return folders.flatMap(f => [...(f.contents ?? [])]);
  }

  #wireMerchantDragDrop() {
    const dropZone = this.element.querySelector('.merchant-template-drop-zone');
    if (!dropZone) return;
    dropZone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
    dropZone.addEventListener('drop', async e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      let data;
      try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (data?.type !== 'Item' && data?.type !== 'Folder') return;

      const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
      const currencies = currencyConfig.currencies ?? [];

      // Capture current DOM state before re-rendering.
      this.#syncSubTypeName();
      this.#syncLodgingsFromDOM();
      this.#syncTemplateInventoryFromDOM();

      if (data.type === 'Item') {
        const item = await fromUuid(data.uuid).catch(() => null);
        if (!item) return;
        this._templateInventory.push(this.#makeInventoryEntry(item, currencies));
      } else {
        const folder = await fromUuid(data.uuid).catch(() => null);
        if (folder?.type !== 'Item') {
          ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.dropFolderWrongType"));
          return;
        }
        const rawItems = this.#collectFolderItems(folder);
        if (!rawItems.length) {
          ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.dropFolderEmpty"));
          return;
        }
        // Compendium folders return index entries — load full documents so readItemPrice works.
        const items = folder.pack
          ? (await Promise.all(rawItems.map(e => fromUuid(e.uuid).catch(() => null)))).filter(Boolean)
          : rawItems;
        for (const item of items) this._templateInventory.push(this.#makeInventoryEntry(item, currencies));
        ui.notifications.info(game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.merchant.dropFolderAdded", { count: items.length }));
      }
      this.render({ parts: ['form'] });
    });
  }

  #syncSubTypeName() {
    this._subType.name = this.element.querySelector('[name="name"]')?.value ?? this._subType.name;
    // Preserve the chosen template type across re-renders (add-template flow only).
    if (!this._typeId) {
      const v = this.element?.querySelector('[name="templateType"]')?.value;
      if (v) this._selectedType = v;
    }
    // Preserve the merchant stock config across re-renders.
    const st = this.element?.querySelector('[name="merchantStockType"]')?.value;
    if (st) this._stockType = st;
    const rf = this.element?.querySelector('[name="merchantRestockFrequency"]')?.value;
    if (rf) this._restockFrequency = rf;
  }

  static #onAddLodging() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const defaultCurrencyId = getStandardCurrency(currencies)?.id ?? "";
    this._lodgings.push({
      id:           foundry.utils.randomID(),
      name:         "",
      beds:         1,
      availability: null,
      pricePerDay:  { currencyId: defaultCurrencyId, amount: 0 },
      pricePerWeek: null
    });
    this.render({ parts: ["form"] });
  }

  static #onDeleteLodging(event, target) {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const index = parseInt(target.dataset.index);
    this._lodgings.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static async #onAddCourse() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const result = await CourseEditApp.open({});
    if (!result) return;
    this._menu.courses.push(result);
    this.render({ parts: ["form"] });
  }

  static async #onEditCourse(event, target) {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const index    = parseInt(target.dataset.courseIndex);
    const existing = this._menu.courses[index];
    if (!existing) return;
    const result = await CourseEditApp.open(existing);
    if (!result) return;
    this._menu.courses[index] = result;
    this.render({ parts: ["form"] });
  }

  static #onDeleteCourse(event, target) {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const index = parseInt(target.dataset.courseIndex);
    this._menu.courses.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static async #onCopyCoursesFromTemplate() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const allTypes = game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES) ?? {};
    const sourceTypes = (allTypes.inn ?? []).filter(t =>
      t.id !== this._typeId &&
      (t.typeData?.menu?.courses?.length ?? 0) > 0
    );
    if (!sourceTypes.length) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.course.noTemplateSources"));
      return;
    }
    const options = sourceTypes.map(t =>
      `<option value="${t.id}">${t.name} (${t.typeData.menu.courses.length} courses)</option>`
    ).join("");
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.course.copyFromTemplateTitle") },
      content: `<div class="form-group"><label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.course.copySource")}</label><select name="sourceTypeId">${options}</select></div>`,
      ok: {
        label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.course.copyBtn"),
        callback: (event, btn) => btn.form.querySelector('[name="sourceTypeId"]')?.value
      }
    });
    if (!result) return;
    const source = sourceTypes.find(t => t.id === result);
    if (!source) return;
    const copies = (source.typeData.menu.courses ?? []).map(c => ({
      ...foundry.utils.deepClone(c),
      id: foundry.utils.randomID(),
      templateItemId: null,
      _templateValues: null
    }));
    this._menu.courses.push(...copies);
    this.render({ parts: ["form"] });
  }

  static async #onImportFromRollTable() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const tables = [...(game.tables ?? [])];
    if (!tables.length) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.course.noRollTables"));
      return;
    }
    const options = tables.map(t =>
      `<option value="${t.id}">${t.name} (${t.results.size} results)</option>`
    ).join("");
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.course.importFromTableTitle") },
      content: `<div class="form-group"><label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.course.tableSource")}</label><select name="tableId">${options}</select></div>`,
      ok: {
        label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.course.importBtn"),
        callback: (event, btn) => btn.form.querySelector('[name="tableId"]')?.value
      }
    });
    if (!result) return;
    const table = game.tables.get(result);
    if (!table?.results?.size) return;
    const pool = [...table.results].map(r => ({
      id:          foundry.utils.randomID(),
      name:        r.name ?? "",
      description: r.description ?? "",
      price:       null
    }));
    const drawMax = Math.min(3, pool.length);
    this._menu.courses.push({
      id:             foundry.utils.randomID(),
      name:           table.name,
      mode:           "random",
      drawCountMin:   1,
      drawCountMax:   drawMax,
      drawCount:      drawMax,
      refreshCadence: "daily",
      price:          null,
      items:          [],
      pool,
      drawnItems:     [],
      lastRefreshed:  null,
      templateItemId: null,
      _templateValues: null
    });
    this.render({ parts: ["form"] });
  }

  static #onAddTemplateInventoryItem() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    this.#syncTemplateInventoryFromDOM();
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const defaultCurrencyId = getStandardCurrency(currencies)?.id ?? "";
    this._templateInventory.push({
      id:                foundry.utils.randomID(),
      name:              "",
      price:             { currencyId: defaultCurrencyId, amount: 0 },
      itemId:            null,
      itemType:          null,
      minSettlementSize:       "",
      stockAvailability: 100,
      stockFormula:      ""
    });
    this.render({ parts: ["form"] });
  }

  static #onDeleteTemplateInventoryItem(event, target) {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    this.#syncTemplateInventoryFromDOM();
    const index = parseInt(target.dataset.index);
    this._templateInventory.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static async #onSortInventory() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    this.#syncTemplateInventoryFromDOM();
    const spec = await MerchantSortDialog.open(this._inventorySort);
    if (!spec) return;
    this._inventorySort = spec;
    if (spec.length) {
      const currencies = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG).currencies ?? [];
      this._templateInventory = sortMerchantInventory(this._templateInventory, spec, currencies);
    }
    this.render({ parts: ["form"] });
  }

  static async #onImportFromCompendium() {
    if (!game.packs.filter(p => p.documentName === "Item").length) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.noCompendiumPacks"));
      return;
    }
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    this.#syncTemplateInventoryFromDOM();

    const selected = await CompendiumItemPickerApp.open();
    if (!selected?.length) return;

    const currencies = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG).currencies ?? [];
    const newEntries = await Promise.all(
      selected.map(async ({ uuid }) => {
        const item = await fromUuid(uuid).catch(() => null);
        return item ? this.#makeInventoryEntry(item, currencies) : null;
      })
    );
    const valid = newEntries.filter(Boolean);
    if (!valid.length) return;
    this._templateInventory.push(...valid);
    ui.notifications.info(game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.merchant.importedCount", { count: valid.length }));
    this.render({ parts: ["form"] });
  }

  static #onSwitchMerchantTab(event, target) {
    this.#syncSubTypeName();
    this._merchantTab = target.dataset.tab ?? "inventory";
    this.render({ parts: ["form"] });
  }

  static #onAddPurchasingRule() {
    this.#syncSubTypeName();
    const addRow = this.element.querySelector('.purchasing-add-row');
    if (!addRow) return;
    const itemType    = addRow.querySelector('[data-field="ruleItemType"]')?.value ?? "";
    const buyRate     = parseFloat(addRow.querySelector('[data-field="ruleBuyRate"]')?.value) || 0;
    const buybackType = addRow.querySelector('[data-field="ruleBuybackType"]')?.value ?? "player";
    if (this._purchasingProfile.some(r => r.itemType === itemType)) return;
    this._purchasingProfile.push({
      id: foundry.utils.randomID(),
      itemType,
      buyRate: Math.max(0, Math.min(100, buyRate)),
      buybackType
    });
    this.render({ parts: ["form"] });
  }

  static #onRemovePurchasingRule(event, target) {
    this.#syncSubTypeName();
    const index = parseInt(target.dataset.index);
    this._purchasingProfile.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  static #onCancel() {
    this.close();
  }

  static async #onSubmit(event, form, formData) {
    if (this._locationMode) return this.#submitLocationEntry(form, formData);

    const name = (formData.object.name ?? "").trim();
    if (!name) return;

    const typeId = this._typeId ?? formData.object.templateType ?? null;
    if (!typeId) return;

    const result = { ...this._subType, name };
    if (typeId === LOCATION_TYPE_IDS.INN) {
      const rows = form.querySelectorAll('.lodging-table-row');
      const lodgings = [...rows]
        .map(row => this.#rowToLodging(row))
        .filter(l => l.name);
      result.typeData = { lodgings, menu: this._menu };
    }
    if (typeId === LOCATION_TYPE_IDS.BANK) {
      const doesExchange       = !!form.querySelector('[name="bankDoesExchange"]')?.checked;
      const exchangeFee        = Math.max(0, Math.min(100, parseFloat(formData.object.bankExchangeFee) || 0));
      const depositGlobal      = !!form.querySelector('[name="bankDepositGlobal"]')?.checked;
      const depositFee         = Math.max(0, Math.min(100, parseFloat(formData.object.bankDepositFee) || 0));
      const minDepositDays     = Math.max(0, parseInt(formData.object.bankMinDepositDays) || 0);
      const earlyWithdrawalFee = Math.max(0, Math.min(100, parseFloat(formData.object.bankEarlyWithdrawalFee) || 0));
      result.typeData = {
        bank: {
          doesExchange,
          exchangeFee,
          depositSettings: { global: depositGlobal, depositFee, minDepositDays, earlyWithdrawalFee }
        }
      };
    }
    if (typeId === LOCATION_TYPE_IDS.MERCHANT) {
      const stockType        = (formData.object.merchantStockType        ?? "percent");
      const restockFrequency = (formData.object.merchantRestockFrequency ?? "weekly");
      this.#syncTemplateInventoryFromDOM();
      result.typeData = { merchant: { stockType, restockFrequency, inventory: this._templateInventory, purchasingProfile: this._purchasingProfile } };
    }
    result._templateTypeId = typeId;

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(result);
  }

  /**
   * Location-mode submit: merge the edited authored fields back onto the original entry (preserving
   * runtime fields via the `...base` spread) and resolve that entry object for the caller to persist.
   */
  #submitLocationEntry(form, formData) {
    const typeId = this._typeId;
    const base   = foundry.utils.deepClone(this._entryBase ?? {});
    let result   = base;

    if (typeId === LOCATION_TYPE_IDS.INN) {
      const rows = form.querySelectorAll('.lodging-table-row');
      const lodgings = [...rows].map(row => this.#rowToLodging(row)).filter(l => l.name);
      result = { ...base, lodgings, menu: this._menu };
    } else if (typeId === LOCATION_TYPE_IDS.BANK) {
      const doesExchange       = !!form.querySelector('[name="bankDoesExchange"]')?.checked;
      const exchangeFee        = Math.max(0, Math.min(100, parseFloat(formData.object.bankExchangeFee) || 0));
      const depositGlobal      = !!form.querySelector('[name="bankDepositGlobal"]')?.checked;
      const depositFee         = Math.max(0, Math.min(100, parseFloat(formData.object.bankDepositFee) || 0));
      const minDepositDays     = Math.max(0, parseInt(formData.object.bankMinDepositDays) || 0);
      const earlyWithdrawalFee = Math.max(0, Math.min(100, parseFloat(formData.object.bankEarlyWithdrawalFee) || 0));
      result = { ...base, doesExchange, exchangeFee, depositSettings: { global: depositGlobal, depositFee, minDepositDays, earlyWithdrawalFee } };
    } else if (typeId === LOCATION_TYPE_IDS.MERCHANT) {
      const stockType        = (formData.object.merchantStockType        ?? "percent");
      const restockFrequency = (formData.object.merchantRestockFrequency ?? "weekly");
      this.#syncTemplateInventoryFromDOM();
      result = { ...base, stockType, restockFrequency, inventory: this._templateInventory, purchasingProfile: this._purchasingProfile };
    }

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(result);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
