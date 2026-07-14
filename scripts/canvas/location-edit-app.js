import { MODULE_ID, FLAGS, SETTINGS, CORE_LOCATION_TYPES, LOCATION_TYPE_IDS, getTypeEntries } from "../constants.js";
import { buildEntryTypeData } from "./location-data.js";

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
        this._typeEntries.push({ id: foundry.utils.randomID(), typeId, subTypeId });
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

    // Init typeData keyed by entry.id for each new entry that has no data yet.
    let typeData = this._location.typeData ?? {};
    const subTypeMap = this.#getSubTypeMap();

    for (const entry of this._typeEntries) {
      if (typeData[entry.id] !== undefined) continue; // already has data
      const subType = (subTypeMap[entry.typeId] ?? []).find(s => s.id === entry.subTypeId);
      typeData = { ...typeData, [entry.id]: buildEntryTypeData(entry.typeId, subType) };
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
