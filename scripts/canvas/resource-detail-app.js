import { MODULE_ID, FLAGS, SETTINGS, RESOURCE_TYPE_IDS, CORE_RESOURCE_TYPES, getTypeEntries } from "../constants.js";
import { PurchaseDialog } from "./purchase-dialog.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { LodgingRentalDialog } from "./inn/lodging-rental-dialog.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { SOCKET_CHANNEL, SOCKET_TYPES } from "../socket.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class ResourceDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resource;
  _activeTab = null;
  _sceneUpdateHook = null;

  constructor(resource, options = {}) {
    super(options);
    this._resource = resource;
  }

  get title() { return this._resource.name; }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-resource-detail`,
    window: { resizable: false },
    position: { width: 420 },
    actions: {
      buyExpense:         ResourceDetailApp.#onBuyExpense,
      switchTab:          ResourceDetailApp.#onSwitchTab,
      addLodging:         ResourceDetailApp.#onAddLodging,
      editLodging:        ResourceDetailApp.#onEditLodging,
      deleteLodging:      ResourceDetailApp.#onDeleteLodging,
      rentLodging:        ResourceDetailApp.#onRentLodging,
      dismissLedgerEntry: ResourceDetailApp.#onDismissLedgerEntry
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

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this._sceneUpdateHook) {
      this._sceneUpdateHook = Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas.scene?.id) return;
        if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.RESOURCES}`)) return;
        const resources = canvas.scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
        const fresh = resources.find(r => r.id === this._resource.id);
        if (fresh) this._resource = fresh;
        this.render();
      });
    }
  }

  async _onClose(options) {
    await super._onClose(options);
    if (this._sceneUpdateHook) {
      Hooks.off("updateScene", this._sceneUpdateHook);
      this._sceneUpdateHook = null;
    }
  }

  async _prepareContext(options) {
    const entries = getTypeEntries(this._resource);
    const typeIds = [...new Set(entries.map(e => e.typeId))];
    if (!this._activeTab || !typeIds.includes(this._activeTab)) {
      this._activeTab = typeIds[0] ?? null;
    }

    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const isGM = game.user.isGM;

    const tabs = typeIds.map(id => {
      const coreType = CORE_RESOURCE_TYPES.find(t => t.id === id);
      const isCurrencyTest = id === RESOURCE_TYPE_IDS.CURRENCY_TEST;
      const isInn = id === RESOURCE_TYPE_IDS.INN;

      const expenses = isCurrencyTest
        ? (this._resource.typeData?.expenses ?? []).map(e => {
            const c = currencies.find(x => x.id === e.currencyId);
            return { ...e, costLabel: `${e.amount} ${c?.abbreviation ?? "?"}` };
          })
        : [];

      const innData = isInn ? this.#buildInnData(currencies, isGM) : null;

      return {
        id,
        name: coreType?.name ?? id,
        icon: coreType?.icon ?? "fa-solid fa-question",
        active: id === this._activeTab,
        isCurrencyTest,
        isInn,
        expenses,
        innData
      };
    });

    return { resource: this._resource, tabs, hasMultipleTabs: tabs.length > 1 };
  }

  #buildInnData(currencies, isGM) {
    const innRaw = this._resource.typeData?.inn ?? { lodgings: [], ledger: [] };
    const { daysPerWeek } = getWorldTimeConfig();
    const worldTime = game.time.worldTime;

    const lodgings = (innRaw.lodgings ?? []).map(l => {
      const dayCurr = currencies.find(c => c.id === l.pricePerDay?.currencyId);
      const dayLabel = `${l.pricePerDay?.amount ?? 0} ${dayCurr?.abbreviation ?? "?"}`;
      const weeklyAmount = l.pricePerWeek?.amount ?? ((l.pricePerDay?.amount ?? 0) * daysPerWeek);
      const weekCurr = l.pricePerWeek ? currencies.find(c => c.id === l.pricePerWeek.currencyId) : dayCurr;
      const weekLabel = `${weeklyAmount} ${weekCurr?.abbreviation ?? "?"}`;
      return { ...l, pricePerDayLabel: dayLabel, pricePerWeekLabel: weekLabel };
    });

    const allLedger = innRaw.ledger ?? [];
    const visibleLedger = isGM
      ? allLedger
      : allLedger.filter(e => e.actorId === game.user.character?.id);

    const ledger = visibleLedger.map(e => {
      const remaining = e.expiresAt - worldTime;
      const isExpired = remaining <= 0;
      let timeRemainingLabel;
      if (isExpired) {
        timeRemainingLabel = game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.expired");
      } else {
        const { totalDays, hour, minute } = secondsToComponents(remaining);
        timeRemainingLabel = `${totalDays}d ${hour}h ${String(minute).padStart(2, "0")}m`;
      }
      return { ...e, isExpired, timeRemainingLabel };
    });

    return { lodgings, ledger, isGM };
  }

  async #saveInnData(innData) {
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const r = resources.find(r => r.id === this._resource.id);
    if (!r) return;
    r.typeData ??= {};
    r.typeData.inn = innData;
    this._resource = r;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this.render();
  }

  static #onSwitchTab(event, target) {
    this._activeTab = target.dataset.tabId;
    this.render();
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

  static async #onAddLodging() {
    if (!game.user.isGM) return;
    const result = await LodgingEditApp.open({});
    if (!result) return;
    result.id ??= foundry.utils.randomID();
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.lodgings.push(result);
    await this.#saveInnData(innData);
  }

  static async #onEditLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
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
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.lodgings = innData.lodgings.filter(l => l.id !== lodgingId);
    await this.#saveInnData(innData);
  }

  static async #onRentLodging(event, target) {
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const lodging = this._resource.typeData?.inn?.lodgings?.find(l => l.id === lodgingId);
    if (!lodging) return;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];

    const rental = await LodgingRentalDialog.open(lodging, currencies);
    if (!rental) return;

    const paymentResult = await PurchaseDialog.open({
      expense: rental.expense,
      currencies,
      mode: currencyConfig.mode ?? "loose"
    });
    if (!paymentResult) return;

    const purchasedAt = game.time.worldTime;
    const entry = {
      id:              foundry.utils.randomID(),
      lodgingId:       lodging.id,
      lodgingName:     lodging.name,
      beds:            lodging.beds,
      actorId:         rental.actorId,
      actorName:       rental.actorName,
      purchasedAt,
      durationSeconds: rental.durationSeconds,
      expiresAt:       purchasedAt + rental.durationSeconds
    };

    if (game.user.isGM) {
      const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
      innData.ledger.push(entry);
      await this.#saveInnData(innData);
    } else {
      // Players lack scene-update permission — ask the active GM to write it.
      game.socket.emit(SOCKET_CHANNEL, {
        type:       SOCKET_TYPES.ADD_LEDGER_ENTRY,
        sceneId:    canvas.scene?.id,
        resourceId: this._resource.id,
        entry
      });
      // The updateScene hook (registered in _onRender) will refresh this view
      // once the GM processes the socket and saves the flag.
    }
  }

  static async #onDismissLedgerEntry(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.entryId;
    if (!entryId) return;
    const innData = foundry.utils.deepClone(this._resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.ledger = innData.ledger.filter(e => e.id !== entryId);
    await this.#saveInnData(innData);
  }
}
