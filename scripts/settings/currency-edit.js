import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CurrencyEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _currency;
  _mode;

  constructor(currency, mode, options = {}) {
    super(options);
    this._currency = currency;
    this._mode = mode;
  }

  get title() {
    const key = this._currency?.name
      ? "SANDBOX_SETTLEMENT_MANAGER.currency.editTitle"
      : "SANDBOX_SETTLEMENT_MANAGER.currency.addTitle";
    return game.i18n.localize(key);
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-currency-edit`,
    tag: "form",
    form: { handler: CurrencyEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    actions: {
      toggleHelp: CurrencyEditApp.#onToggleHelp,
      clearItem:  CurrencyEditApp.#onClearItem
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/currency-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(currency = {}, mode = "loose") {
    return new Promise(resolve => {
      const app = new CurrencyEditApp(foundry.utils.deepClone(currency), mode);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      currency: this._currency,
      isAttribute: this._mode === "attribute",
      isItem: this._mode === "item",
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();
    if (this._mode === "item") this.#setupItemSearch();
  }

  #setupItemSearch() {
    const searchInput = this.element.querySelector(".item-search-input");
    const resultsList = this.element.querySelector(".item-search-results");
    const selectedItem = this.element.querySelector(".selected-item");
    const selectedName = this.element.querySelector(".selected-item-name");
    if (!searchInput || !resultsList) return;

    searchInput.addEventListener("input", () => {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) { resultsList.innerHTML = ""; return; }

      const worldMatches = game.items.contents
        .filter(i => i.name.toLowerCase().includes(query))
        .map(i => ({ uuid: i.uuid, name: i.name, img: i.img, fromPack: false }));

      const packMatches = [];
      for (const pack of game.packs) {
        if (pack.documentName !== "Item") continue;
        for (const entry of pack.index) {
          if (entry.name.toLowerCase().includes(query))
            packMatches.push({ uuid: entry.uuid, name: entry.name, img: entry.img, fromPack: true });
        }
      }

      const matches = [...worldMatches, ...packMatches].slice(0, 12);

      resultsList.innerHTML = matches
        .map(i => `<li class="item-search-result" data-uuid="${i.uuid}" data-name="${i.name}">
          ${i.img ? `<img src="${i.img}" width="18" height="18">` : ""}
          <span>${i.name}</span>${i.fromPack ? `<em class="item-search-pack-tag">(Compendium)</em>` : ""}</li>`)
        .join("");

      resultsList.querySelectorAll(".item-search-result").forEach(li => {
        li.addEventListener("click", () => {
          this._currency.itemId = li.dataset.uuid;
          this._currency.itemName = li.dataset.name;
          if (selectedName) selectedName.textContent = li.dataset.name;
          selectedItem?.classList.remove("hidden");
          resultsList.innerHTML = "";
          searchInput.value = "";
        });
      });
    });
  }

  static #onToggleHelp() {
    this.element.querySelector(".exchange-rate-help")?.classList.toggle("hidden");
  }

  static #onClearItem() {
    this._currency.itemId = "";
    this._currency.itemName = "";
    this.render({ parts: ["form"] });
  }

  static async #onSubmit(event, form, formData) {
    const name = (formData.object.name ?? "").trim();
    if (!name) return;
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._currency.id || foundry.utils.randomID(),
      name,
      abbreviation: (formData.object.abbreviation ?? "").trim(),
      isStandard: !!formData.object.isStandard,
      exchangeRate: (formData.object.exchangeRate ?? "1:1").trim() || "1:1",
      attributePath: (formData.object.attributePath ?? "").trim(),
      itemId: this._currency.itemId ?? "",
      itemName: this._currency.itemName ?? "",
      quantityPath: (formData.object.quantityPath ?? "").trim()
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
