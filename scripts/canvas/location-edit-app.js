import { MODULE_ID, FLAGS, SETTINGS, CORE_LOCATION_TYPES, LOCATION_TYPE_IDS, getTypeEntries } from "../constants.js";
import { instanceFromTemplate, snapshot, TEMPLATE_FIELDS } from "./template-link.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class LocationEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _location;
  _typeEntries;
  #pickerAbort = null;
  #pickerDropdown = null;

  constructor(location, options = {}) {
    super(options);
    this._location = location;
    this._typeEntries = getTypeEntries(location).map(e => ({ ...e }));
  }

  get title() {
    const key = this._location?.name
      ? "SANDBOX_SETTLEMENT_MANAGER.location.editTitle"
      : "SANDBOX_SETTLEMENT_MANAGER.location.addTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-location-edit`,
    tag: "form",
    form: { handler: LocationEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 380 },
    actions: {
      removeTypeEntry: LocationEditApp.#onRemoveTypeEntry
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/canvas/location-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(location = {}) {
    return new Promise(resolve => {
      const app = new LocationEditApp(foundry.utils.deepClone(location));
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const subTypeMap = this.#getSubTypeMap();
    const selectedSet = new Set(this._typeEntries.map(e => `${e.typeId}::${e.subTypeId ?? ""}`));

    const typeEntries = this._typeEntries.map((entry, index) => {
      const coreType = CORE_LOCATION_TYPES.find(t => t.id === entry.typeId);
      const subTypes = subTypeMap[entry.typeId] ?? [];
      const subType = entry.subTypeId ? subTypes.find(s => s.id === entry.subTypeId) : null;
      return {
        ...entry,
        index,
        typeIcon: coreType?.icon ?? "fa-solid fa-question",
        typeName: coreType?.name ?? entry.typeId,
        subTypeName: subType?.name ?? null
      };
    });

    const pickerGroups = CORE_LOCATION_TYPES.map(t => {
      const allSubTypes = subTypeMap[t.id] ?? [];
      const availSubTypes = allSubTypes
        .filter(s => !selectedSet.has(`${t.id}::${s.id}`))
        .map(s => ({ id: s.id, name: s.name }));
      const typeItselfAvailable = !selectedSet.has(`${t.id}::`);
      return {
        typeId: t.id,
        name: t.name,
        icon: t.icon,
        typeItselfAvailable,
        subTypes: availSubTypes
      };
    }).filter(g => g.typeItselfAvailable || g.subTypes.length > 0);

    return {
      location: this._location,
      typeEntries,
      pickerGroups,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  #getSubTypeMap() {
    const raw = game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES);
    return Array.isArray(raw) ? {} : (raw ?? {});
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
    this.#setupPicker();
  }

  #setupPicker() {
    // Abort previous listeners and remove previous body-mounted dropdown
    this.#pickerAbort?.abort();
    this.#pickerAbort = new AbortController();
    const { signal } = this.#pickerAbort;

    this.#pickerDropdown?.remove();
    this.#pickerDropdown = null;

    const trigger = this.element.querySelector(".add-type-trigger");
    const dropdown = trigger?.querySelector(".type-picker-dropdown");
    if (!trigger || !dropdown) return;

    document.body.appendChild(dropdown);
    this.#pickerDropdown = dropdown;

    // Open / close
    trigger.querySelector(".add-type-btn")?.addEventListener("click", e => {
      e.stopPropagation();
      const rect = trigger.getBoundingClientRect();
      dropdown.style.top = `${rect.bottom + 2}px`;
      dropdown.style.left = `${rect.left}px`;
      dropdown.classList.toggle("is-open");
      dropdown.querySelector(".type-picker-filter")?.focus();
    }, { signal });

    // Close on outside click
    document.addEventListener("click", () => dropdown.classList.remove("is-open"), { signal });
    dropdown.addEventListener("click", e => e.stopPropagation(), { signal });

    // Filter
    const filterInput = dropdown.querySelector(".type-picker-filter");
    filterInput?.addEventListener("input", () => {
      const q = filterInput.value.trim().toLowerCase();
      dropdown.querySelectorAll(".picker-group").forEach(group => {
        const typeItem = group.querySelector(".picker-type-item");
        const typeText = (typeItem?.textContent ?? "").toLowerCase();
        const typeMatches = !q || typeText.includes(q);
        let anySubMatch = false;
        group.querySelectorAll(".picker-subtype-item").forEach(item => {
          const subMatch = typeMatches || item.textContent.toLowerCase().includes(q);
          item.hidden = !subMatch;
          if (subMatch) anySubMatch = true;
        });
        if (typeItem) typeItem.hidden = !typeMatches;
        group.hidden = !typeMatches && !anySubMatch;
      });
    }, { signal });

    // Item selection
    dropdown.querySelectorAll(".picker-item").forEach(item => {
      item.addEventListener("click", () => {
        this.#syncName();
        const typeId = item.dataset.typeId;
        const subTypeId = item.dataset.subTypeId || null;
        this._typeEntries.push({ typeId, subTypeId });
        dropdown.classList.remove("is-open");
        this.render({ parts: ["form"] });
      }, { signal });
    });
  }

  static #onRemoveTypeEntry(event, target) {
    this.#syncName();
    const index = parseInt(target.dataset.entryIndex);
    this._typeEntries.splice(index, 1);
    this.render({ parts: ["form"] });
  }

  // Capture the current name input value into _location so partial re-renders preserve it.
  #syncName() {
    const current = this.element.querySelector('[name="name"]')?.value ?? "";
    this._location.name = current;
  }

  #generateDefaultName() {
    const firstEntry = this._typeEntries[0];
    const primaryType = CORE_LOCATION_TYPES.find(t => t.id === firstEntry?.typeId);
    const typeName = primaryType?.name ?? "Location";
    const existing = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
    const sameTypeCount = existing.filter(r =>
      getTypeEntries(r).some(e => e.typeId === firstEntry?.typeId)
    ).length;
    return `${typeName} ${sameTypeCount + 1}`;
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim() || this.#generateDefaultName();

    // Auto-init inn typeData from sub-type defaults when an inn entry is added for the first time
    const innEntry = this._typeEntries.find(e => e.typeId === LOCATION_TYPE_IDS.INN);
    let typeData = this._location.typeData ?? {};
    const merchantEntry = this._typeEntries.find(e => e.typeId === LOCATION_TYPE_IDS.MERCHANT);
    if (merchantEntry && !typeData.merchant) {
      const subTypeMap = this.#getSubTypeMap();
      const merchantSubType = (subTypeMap[LOCATION_TYPE_IDS.MERCHANT] ?? [])
        .find(s => s.id === merchantEntry.subTypeId);
      const templateItems = foundry.utils.deepClone(merchantSubType?.typeData?.merchant?.inventory ?? []);
      const tpl = merchantSubType?.typeData?.merchant ?? {};
      typeData = {
        ...typeData,
        merchant: {
          stockType:            tpl.stockType        ?? "percent",
          restockFrequency:     tpl.restockFrequency ?? "weekly",
          _tplStockType:        tpl.stockType        ?? "percent",
          _tplRestockFrequency: tpl.restockFrequency ?? "weekly",
          lastRestocked:        null,
          inventory: templateItems.map(item => ({
            ...item,
            templateItemId: item.id,
            quantity:       null,
            _templateValues: {
              name:              item.name,
              itemId:            item.itemId            ?? null,
              minSettlementSize:       item.minSettlementSize       ?? "",
              stockAvailability: item.stockAvailability ?? 100,
              stockFormula:      item.stockFormula      ?? "",
              price:             { ...(item.price ?? {}) }
            }
          }))
        }
      };
    }

    if (innEntry && !typeData.inn) {
      const subTypeMap = this.#getSubTypeMap();
      const subType = (subTypeMap[LOCATION_TYPE_IDS.INN] ?? []).find(s => s.id === innEntry.subTypeId);
      typeData = {
        ...typeData,
        inn: {
          lodgings: (subType?.typeData?.lodgings ?? []).map(l => instanceFromTemplate(l, TEMPLATE_FIELDS.lodging)),
          ledger: [],
          menu: {
            courses: (subType?.typeData?.menu?.courses ?? []).map(c => instanceFromTemplate(c, TEMPLATE_FIELDS.course))
          }
        }
      };
    }

    const bankEntry = this._typeEntries.find(e => e.typeId === LOCATION_TYPE_IDS.BANK);
    if (bankEntry && !typeData.bank) {
      const subTypeMap = this.#getSubTypeMap();
      const bankSubType = (subTypeMap[LOCATION_TYPE_IDS.BANK] ?? [])
        .find(s => s.id === bankEntry.subTypeId);
      const tpl = bankSubType?.typeData?.bank ?? {};
      const bankSettings = {
        doesExchange:    tpl.doesExchange ?? true,
        exchangeFee:     tpl.exchangeFee  ?? 0,
        depositSettings: tpl.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 }
      };
      typeData = {
        ...typeData,
        bank: {
          ...bankSettings,
          _templateValues: snapshot(bankSettings, TEMPLATE_FIELDS.bank),
          deposits: [],
          loans: []
        }
      };
    }

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._location.id || foundry.utils.randomID(),
      typeEntries: this._typeEntries.slice(),
      name,
      ownerId: null,
      discovered: {
        default: !!formData.object.discovered,
        parties: {}
      },
      typeData
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#pickerAbort?.abort();
    this.#pickerDropdown?.remove();
    this.#pickerDropdown = null;
    this._resolve?.(null);
    this._resolve = null;
  }
}
