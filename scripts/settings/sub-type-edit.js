import { MODULE_ID, SETTINGS, RESOURCE_TYPE_IDS, CORE_RESOURCE_TYPES } from "../constants.js";
import { CourseEditApp } from "../canvas/inn/course-edit-app.js";
import { getWorldTimeConfig } from "../time/world-time.js";
import { readItemName, readItemPrice } from "../utils/item-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class SubTypeEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _subType;
  _typeId = null;
  _lodgings = [];
  _menu = { courses: [] };
  _templateInventory = [];

  constructor(subType, options = {}) {
    super(options);
    this._subType = subType;
  }

  get title() {
    const key = this._subType?.name
      ? "SANDBOX_SETTLEMENT_MANAGER.resourceType.subType.editTitle"
      : "SANDBOX_SETTLEMENT_MANAGER.resourceType.subType.addTitle";
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
      addTemplateInventoryItem:   SubTypeEditApp.#onAddTemplateInventoryItem,
      deleteTemplateInventoryItem: SubTypeEditApp.#onDeleteTemplateInventoryItem
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
      app._resolve  = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const isInn             = this._typeId === RESOURCE_TYPE_IDS.INN;
    const isMerchant        = this._typeId === RESOURCE_TYPE_IDS.MERCHANT;
    const showTypeSelect    = !this._typeId;
    const showInnSections     = isInn || showTypeSelect;
    const showMerchantSection = isMerchant || showTypeSelect;
    let lodgings = [];
    let currencies = [];
    let courses = [];
    let templateInventory = [];
    if (showInnSections || showMerchantSection) {
      const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
      currencies = currencyConfig.currencies ?? [];
      const defaultCurrencyId = currencies[0]?.id ?? "";
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
        templateInventory = await Promise.all(this._templateInventory.map(async item => ({
          ...item,
          price: item.price ?? { currencyId: defaultCurrencyId, amount: 0 },
          enrichedName: item.itemId
            ? await TextEditor.enrichHTML(`@UUID[${item.itemId}]{${item.name}}`, { async: true })
            : null
        })));
      }
    }
    const cityTypes = game.settings.get(MODULE_ID, SETTINGS.CITY_TYPES) ?? [];
    const merchantData = this._subType.typeData?.merchant ?? {};
    const stockType       = merchantData.stockType        ?? "percent";
    const restockFrequency = merchantData.restockFrequency ?? "weekly";
    return {
      subType: this._subType,
      isInn,
      isMerchant,
      showTypeSelect,
      showInnSections,
      showMerchantSection,
      showTypeSpecificSections: showInnSections || showMerchantSection,
      coreTypes: CORE_RESOURCE_TYPES,
      lodgings,
      currencies,
      courses,
      templateInventory,
      cityTypes,
      stockType,
      restockFrequency,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
    if (!this._typeId) this.#wireTypeSelect();
    this.#wireWeeklyLinks();
    this.#wireMerchantDragDrop();
  }

  #wireTypeSelect() {
    const sel = this.element.querySelector('[name="templateType"]');
    if (!sel) return;
    const innSection      = this.element.querySelector('.inn-only');
    const merchantSection = this.element.querySelector('.merchant-only');
    const toggle = () => {
      if (innSection)      innSection.hidden      = (sel.value !== RESOURCE_TYPE_IDS.INN);
      if (merchantSection) merchantSection.hidden = (sel.value !== RESOURCE_TYPE_IDS.MERCHANT);
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
    return {
      id:           row.dataset.lodgingId || foundry.utils.randomID(),
      name:         (row.querySelector('[data-field="name"]')?.value ?? "").trim(),
      beds:         Math.max(1, parseInt(row.querySelector('[data-field="beds"]')?.value) || 1),
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
    this._templateInventory = [...rows].map(row => ({
      id:               row.dataset.inventoryItemId || foundry.utils.randomID(),
      name:             (row.querySelector('[data-field="name"]')?.value ?? "").trim(),
      itemId:           row.dataset.itemUuid ?? null,
      itemType:         row.dataset.itemType ?? null,
      minCitySize:      (row.querySelector('[data-field="minCitySize"]')?.value ?? "").trim(),
      stockAvailability: parseFloat(row.querySelector('[data-field="stockAvailability"]')?.value) || 100,
      stockFormula:     (row.querySelector('[data-field="stockFormula"]')?.value ?? "").trim(),
      price: {
        currencyId: row.querySelector('[data-field="priceCurrencyId"]')?.value ?? "",
        amount:     parseFloat(row.querySelector('[data-field="priceAmount"]')?.value) || 0
      }
    }));
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
      if (data?.type !== 'Item') return;
      const item = await fromUuid(data.uuid).catch(() => null);
      if (!item) return;
      const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
      const currencies = currencyConfig.currencies ?? [];
      this.#syncSubTypeName();
      this.#syncLodgingsFromDOM();
      this.#syncTemplateInventoryFromDOM();
      this._templateInventory.push({
        id:                foundry.utils.randomID(),
        name:              readItemName(item),
        price:             readItemPrice(item, currencies),
        itemId:            item.uuid,
        itemType:          item.type ?? null,
        minCitySize:       "",
        stockAvailability: 100,
        stockFormula:      ""
      });
      this.render({ parts: ['form'] });
    });
  }

  #syncSubTypeName() {
    this._subType.name = this.element.querySelector('[name="name"]')?.value ?? this._subType.name;
  }

  static #onAddLodging() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const defaultCurrencyId = currencyConfig.currencies?.[0]?.id ?? "";
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

  static #onAddTemplateInventoryItem() {
    this.#syncSubTypeName();
    this.#syncLodgingsFromDOM();
    this.#syncTemplateInventoryFromDOM();
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const defaultCurrencyId = currencyConfig.currencies?.[0]?.id ?? "";
    this._templateInventory.push({
      id:                foundry.utils.randomID(),
      name:              "",
      price:             { currencyId: defaultCurrencyId, amount: 0 },
      itemId:            null,
      itemType:          null,
      minCitySize:       "",
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

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;

    const typeId = this._typeId ?? formData.object.templateType ?? null;
    if (!typeId) return;

    const result = { ...this._subType, name };
    if (typeId === RESOURCE_TYPE_IDS.INN) {
      const rows = form.querySelectorAll('.lodging-table-row');
      const lodgings = [...rows]
        .map(row => this.#rowToLodging(row))
        .filter(l => l.name);
      result.typeData = { lodgings, menu: this._menu };
    }
    if (typeId === RESOURCE_TYPE_IDS.MERCHANT) {
      const stockType        = (formData.object.merchantStockType        ?? "percent");
      const restockFrequency = (formData.object.merchantRestockFrequency ?? "weekly");
      const rows = form.querySelectorAll('.merchant-inventory-row');
      const inventory = [...rows]
        .map(row => ({
          id:                row.dataset.inventoryItemId || foundry.utils.randomID(),
          name:              (row.querySelector('[data-field="name"]')?.value ?? "").trim(),
          itemId:            row.dataset.itemUuid ?? null,
          itemType:          row.dataset.itemType ?? null,
          minCitySize:       (row.querySelector('[data-field="minCitySize"]')?.value ?? "").trim(),
          stockAvailability: parseFloat(row.querySelector('[data-field="stockAvailability"]')?.value) || 100,
          stockFormula:      (row.querySelector('[data-field="stockFormula"]')?.value ?? "").trim(),
          price: {
            currencyId: row.querySelector('[data-field="priceCurrencyId"]')?.value ?? "",
            amount:     parseFloat(row.querySelector('[data-field="priceAmount"]')?.value) || 0
          }
        }))
        .filter(item => item.name);
      result.typeData = { merchant: { stockType, restockFrequency, inventory } };
    }
    result._templateTypeId = typeId;

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
