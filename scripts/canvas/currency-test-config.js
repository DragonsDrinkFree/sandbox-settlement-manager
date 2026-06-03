import { MODULE_ID, FLAGS, SETTINGS } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CurrencyTestConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resource;
  _scene;

  constructor(resource, scene, options = {}) {
    super(options);
    this._resource = resource;
    this._scene = scene;
  }

  get title() {
    return `${this._resource.name} — ${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.currencyTest.configTitle")}`;
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-currency-test-config`,
    window: { resizable: true },
    position: { width: 460 },
    actions: {
      addExpense:    CurrencyTestConfigApp.#onAddExpense,
      deleteExpense: CurrencyTestConfigApp.#onDeleteExpense
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/currency-test-config.hbs`, scrollable: [""] }
  };

  static open(resource, scene) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-currency-test-config`);
    if (existing) { existing.bringToFront?.(); return; }
    new CurrencyTestConfigApp(resource, scene).render(true);
  }

  async _prepareContext(options) {
    const currencies = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG).currencies ?? [];
    const expenses = this._resource.typeData?.expenses ?? [];
    return {
      expenses: expenses.map(e => ({
        ...e,
        currencyLabel: (() => {
          const c = currencies.find(x => x.id === e.currencyId);
          return c ? `${e.amount} ${c.abbreviation}` : `${e.amount} ?`;
        })()
      })),
      currencies: currencies.map(c => ({ value: c.id, label: `${c.name} (${c.abbreviation})` }))
    };
  }

  async #saveExpenses() {
    const resources = (this._scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? []).map(r =>
      foundry.utils.deepClone(r)
    );
    const idx = resources.findIndex(r => r.id === this._resource.id);
    if (idx === -1) return;
    resources[idx].typeData = foundry.utils.deepClone(this._resource.typeData ?? { expenses: [] });
    await this._scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
  }

  static async #onAddExpense() {
    const name = this.element.querySelector('[name="newExpenseName"]')?.value.trim();
    const currencyId = this.element.querySelector('[name="newExpenseCurrency"]')?.value;
    const amount = parseFloat(this.element.querySelector('[name="newExpenseAmount"]')?.value) || 0;
    if (!name || !currencyId || amount <= 0) return;
    this._resource.typeData ??= { expenses: [] };
    this._resource.typeData.expenses ??= [];
    this._resource.typeData.expenses.push({
      id: foundry.utils.randomID(), name, description: "", currencyId, amount
    });
    await this.#saveExpenses();
    this.render({ parts: ["content"] });
  }

  static async #onDeleteExpense(event, target) {
    const id = target.closest("[data-expense-id]")?.dataset.expenseId;
    if (!id) return;
    const expenses = this._resource.typeData?.expenses ?? [];
    const idx = expenses.findIndex(e => e.id === id);
    if (idx === -1) return;
    expenses.splice(idx, 1);
    await this.#saveExpenses();
    this.render({ parts: ["content"] });
  }
}
