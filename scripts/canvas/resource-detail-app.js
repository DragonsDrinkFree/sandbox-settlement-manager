import { MODULE_ID, SETTINGS, RESOURCE_TYPE_IDS } from "../constants.js";
import { PurchaseDialog } from "./purchase-dialog.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ResourceDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resource;

  constructor(resource, options = {}) {
    super(options);
    this._resource = resource;
  }

  get title() { return this._resource.name; }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-resource-detail`,
    window: { resizable: false },
    position: { width: 340 },
    actions: {
      buyExpense: ResourceDetailApp.#onBuyExpense
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

  async _prepareContext(options) {
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const isCurrencyTest = this._resource.typeId === RESOURCE_TYPE_IDS.CURRENCY_TEST;
    const expenses = isCurrencyTest
      ? (this._resource.typeData?.expenses ?? []).map(e => {
          const c = currencies.find(x => x.id === e.currencyId);
          return { ...e, costLabel: `${e.amount} ${c?.abbreviation ?? "?"}` };
        })
      : [];
    return { resource: this._resource, isCurrencyTest, expenses };
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
}
