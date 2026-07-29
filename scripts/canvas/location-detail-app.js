import { MODULE_ID, FLAGS, SETTINGS, LOCATION_TYPE_IDS, CORE_LOCATION_TYPES, getTypeEntries } from "../constants.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { cartManager } from "./cart-manager.js";
import { CartApp } from "./cart-app.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { calculateChange, formatAmounts, parseExchangeRate, totalOfferedInStandard, removeCoinsFromActor, getMaxDenomValue } from "../utils/currency-utils.js";
import { WithdrawalDialog } from "./withdrawal-dialog.js";
import { SOCKET_CHANNEL, SOCKET_TYPES, _handleRecordDeposit, _handleProcessWithdrawal, _handleEditDeposit, _handleAcceptLoan, _handleDeclineLoan, _handleRepayLoan } from "../socket.js";
import { DepositEditApp } from "./deposit-edit-app.js";
import { LoanOfferApp } from "./loan-offer-app.js";
import { periodSecondsFor, accrueLoan, insufficientCurrencies, selectPayoffCoins } from "../utils/loan-utils.js";
import { MerchantItemEditApp } from "./merchant-item-edit-app.js";
import { mergePurchasingProfiles, findEffectiveRule, computeSalePrice } from "./purchasing-utils.js";
import { restoreFields, TEMPLATE_FIELDS } from "./template-link.js";
import { MerchantRestoreDialog } from "./merchant-restore-dialog.js";
import { buildMerchantData, buildBankData, buildInnData, buildSellData, rollMerchantRestock, applyPriceVariation, rollMerchantBuyRates, readPriceVarConfig, forceRefreshInn } from "./location-data.js";
import { SubTypeEditApp } from "../settings/sub-type-edit.js";
import { restoreLodgingAvailability, consumeLodgingAvailability } from "./lodging-utils.js";
import { BookingEditApp } from "./inn/booking-edit-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class LocationDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _location;
  _activeTab = null;
  _sellTabActive = false;
  _sellActorId   = null;
  _bankActorId   = null;
  _sceneUpdateHook = null;
  _worldTimeHook   = null;
  _bankActorFilter = { playerOwned: true, types: null };
  _sellActorFilter = { playerOwned: true, types: null };
  #actorWidgetAbort = null;
  #actorDropdownEls = [];

  constructor(location, options = {}) {
    super(options);
    this._location = location;
  }

  get title() { return this._location.name; }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-location-detail`,
    window: { resizable: false },
    position: { width: 420 },
    actions: {
      switchTab:          LocationDetailApp.#onSwitchTab,
      editLocationEntry:  LocationDetailApp.#onEditLocationEntry,
      editLodging:        LocationDetailApp.#onEditLodging,
      deleteLodging:      LocationDetailApp.#onDeleteLodging,
      rentLodging:        LocationDetailApp.#onRentLodging,
      dismissLedgerEntry: LocationDetailApp.#onDismissLedgerEntry,
      editBooking:        LocationDetailApp.#onEditBooking,
      addBooking:         LocationDetailApp.#onAddBooking,
      forceRefreshInn:    LocationDetailApp.#onForceRefreshInn,
      refreshCourse:      LocationDetailApp.#onRefreshCourse,
      buyMenuItem:        LocationDetailApp.#onBuyMenuItem,
      buyInventoryItem:         LocationDetailApp.#onBuyInventoryItem,
      deleteMerchantItem:       LocationDetailApp.#onDeleteMerchantItem,
      editMerchantItem:         LocationDetailApp.#onEditMerchantItem,
      restoreFromMerchantTemplate:    LocationDetailApp.#onRestoreFromMerchantTemplate,
      forceRestockMerchant:           LocationDetailApp.#onForceRestockMerchant,
      switchToSellTab:                LocationDetailApp.#onSwitchToSellTab,
      switchFromSellTab:        LocationDetailApp.#onSwitchFromSellTab,
      selectSellActor:          LocationDetailApp.#onSelectSellActor,
      addToSellCart:            LocationDetailApp.#onAddToSellCart,
      buyBackItem:              LocationDetailApp.#onBuyBackItem,
      addExchangeToCart:        LocationDetailApp.#onAddExchangeToCart,
      depositCoins:             LocationDetailApp.#onDepositCoins,
      withdrawDeposit:          LocationDetailApp.#onWithdrawDeposit,
      editDeposit:              LocationDetailApp.#onEditDeposit,
      resetBankSettings:        LocationDetailApp.#onResetBankSettings,
      createLoanOffer:          LocationDetailApp.#onCreateLoanOffer,
      acceptLoan:               LocationDetailApp.#onAcceptLoan,
      declineLoan:              LocationDetailApp.#onDeclineLoan,
      repayLoan:                LocationDetailApp.#onRepayLoan,
      payOffLoan:               LocationDetailApp.#onPayOffLoan,
      cancelLoan:               LocationDetailApp.#onCancelLoan,
      editLoan:                 LocationDetailApp.#onEditLoan
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/location-detail.hbs` }
  };

  static open(location) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-location-detail`);
    if (existing) existing.close();
    new LocationDetailApp(location).render(true);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this._sceneUpdateHook) {
      this._sceneUpdateHook = Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas.scene?.id) return;
        const locationsChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.LOCATIONS}`);
        const settlementTypeChanged  = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.SETTLEMENT_TYPE}`);
        if (!locationsChanged && !settlementTypeChanged) return;
        if (locationsChanged) {
          const locations = canvas.scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
          const fresh = locations.find(r => r.id === this._location.id);
          if (fresh) this._location = fresh;
        }
        this.render();
      });
    }

    if (!this._worldTimeHook && game.user.isGM) {
      // Debounce so advancing/scrubbing world time doesn't trigger a render (and its fromUuid pass) per tick.
      const debounced = foundry.utils.debounce(() => this.render(), 250);
      this._worldTimeHook = Hooks.on("updateWorldTime", () => debounced());
    }

    this.#wireActorWidgets();

    // Wire bank exchange live preview
    const exchangeSection = this.element.querySelector('.ssm-bank-exchange');
    if (exchangeSection) this.#wireExchangePreview(exchangeSection);
  }

  static async #onEditLocationEntry() {
    if (!game.user.isGM) return;
    const entry = this.#getActiveEntry();
    if (!entry) return;
    const entryData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? {});
    const result = await SubTypeEditApp.openForEntry(entry.typeId, entryData, { locationName: this._location.name });
    if (!result) return;
    await this.#saveEntryData(this._activeTab, result);
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#actorWidgetAbort?.abort();
    for (const el of this.#actorDropdownEls) el.remove();
    this.#actorDropdownEls = [];
    document.querySelector('.ssm-actor-filter-menu')?.remove();
    if (this._sceneUpdateHook) {
      Hooks.off("updateScene", this._sceneUpdateHook);
      this._sceneUpdateHook = null;
    }
    if (this._worldTimeHook) {
      Hooks.off("updateWorldTime", this._worldTimeHook);
      this._worldTimeHook = null;
    }
  }

  async _prepareContext(options) {
    const entries = getTypeEntries(this._location);
    const subTypeMap = game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES) ?? {};
    if (!this._activeTab || !entries.some(e => e.id === this._activeTab)) {
      this._activeTab = entries[0]?.id ?? null;
    }

    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];
    const isGM = game.user.isGM;

    const tabs = await Promise.all(entries.map(async entry => {
      const coreType   = CORE_LOCATION_TYPES.find(t => t.id === entry.typeId);
      const subType    = entry.subTypeId ? (subTypeMap[entry.typeId] ?? []).find(s => s.id === entry.subTypeId) ?? null : null;
      const isInn      = entry.typeId === LOCATION_TYPE_IDS.INN;
      const isMerchant = entry.typeId === LOCATION_TYPE_IDS.MERCHANT;
      const isBank     = entry.typeId === LOCATION_TYPE_IDS.BANK;

      const innData = isInn ? buildInnData(entry, this._location, currencies, isGM) : null;
      if (innData?._needsSave && isGM) this.#saveEntryData(entry.id, innData._updatedInn).catch(err => console.error(`${MODULE_ID} | Failed to save inn menu refresh`, err));

      let merchantData = null;
      if (isMerchant) {
        merchantData = await buildMerchantData(entry, this._location, currencies, isGM);
        if (merchantData._needsSave && isGM) this.#saveEntryData(entry.id, merchantData._updatedMerchant).catch(err => console.error(`${MODULE_ID} | Failed to save merchant restock`, err));
        if (isGM) merchantData.canRestore = !!this.#getTemplateForEntry(entry);
      }
      const bankData = isBank ? buildBankData(this, entry, this._location, currencies) : null;

      return {
        id: entry.id,
        name: subType?.name ?? coreType?.name ?? entry.typeId,
        icon: coreType?.icon ?? "fa-solid fa-question",
        active: entry.id === this._activeTab && !this._sellTabActive,
        isInn, isMerchant, isBank,
        innData,
        merchantData,
        bankData
      };
    }));

    // Sell tab: check if any merchant template has a purchasing profile
    const effectiveProfile = mergePurchasingProfiles(this._location);
    const hasSellTab = effectiveProfile.length > 0;
    let sellData = null;
    if (hasSellTab) {
      sellData = await buildSellData(this, this._location, currencies, isGM, effectiveProfile);
    }
    if (hasSellTab && this._sellTabActive && tabs.length > 0) {
      tabs.forEach(t => { t.active = false; });
    }

    return {
      location: this._location, tabs,
      hasMultipleTabs: tabs.length > 1 || hasSellTab,
      hasSellTab, sellTabActive: this._sellTabActive && hasSellTab,
      sellData, isGM
    };
  }

  async #saveEntryData(entryId, data) {
    const locations = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
    const r = locations.find(r => r.id === this._location.id);
    if (!r) return;
    r.typeData ??= {};
    r.typeData[entryId] = data;
    this._location = r;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    this.render();
  }

  #wireExchangePreview(section) {
    const feeRate      = parseFloat(section.dataset.feeRate) || 0;
    const fromAmtInput = section.querySelector('[data-field="fromAmount"]');
    const fromSel      = section.querySelector('[data-field="fromCurrency"]');
    const toSel        = section.querySelector('[data-field="toCurrency"]');
    const toPreview    = section.querySelector('[data-field="toAmountPreview"]');
    const feeEl        = section.querySelector('.ssm-exchange-fee-preview');
    const addBtn       = section.querySelector('[data-action="addExchangeToCart"]');

    const update = () => {
      const fromAmount = parseInt(fromAmtInput?.value) || 0;
      const fromOpt    = fromSel?.selectedOptions[0];
      const toOpt      = toSel?.selectedOptions[0];
      const balance    = parseFloat(fromOpt?.dataset.balance ?? '0');
      const sameCurr   = fromOpt?.value && fromOpt.value === toOpt?.value;
      const invalid    = !fromAmount || !fromOpt || !toOpt || sameCurr || fromAmount > balance;
      if (addBtn) addBtn.disabled = invalid;
      if (!fromAmount || !fromOpt || !toOpt || sameCurr) {
        if (toPreview) toPreview.value = '';
        if (feeEl) feeEl.textContent = '';
        return;
      }
      const fromRate = parseExchangeRate(fromOpt.dataset.rate);
      const toRate   = parseExchangeRate(toOpt.dataset.rate);
      const fromStd  = fromAmount * fromRate;
      if (toPreview) toPreview.value = toRate > 0 ? Math.floor(fromStd / toRate) : 0;
      if (feeEl) {
        if (feeRate > 0) {
          const feeStd     = fromStd * feeRate / 100;
          const currencies = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
          const maxDenom   = currencies.reduce((m, c) => Math.max(m, parseExchangeRate(c.exchangeRate)), 0);
          const feeChange  = calculateChange(feeStd, currencies, maxDenom);
          feeEl.textContent = feeChange ? `Fee: ${formatAmounts(feeChange, currencies)}` : '';
        } else {
          feeEl.textContent = '';
        }
      }
    };

    // Set initial state (button disabled until user enters a valid amount)
    if (addBtn) addBtn.disabled = true;
    fromAmtInput?.addEventListener('input', update);
    fromSel?.addEventListener('change', update);
    toSel?.addEventListener('change', update);
  }

  static #onSwitchTab(event, target) {
    this._activeTab = target.dataset.tabId;
    this.render();
  }

  static async #onEditLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    const index   = innData.lodgings.findIndex(l => l.id === lodgingId);
    if (index === -1) return;
    const lodging         = innData.lodgings[index];
    const template        = lodging.templateItemId ? this.#getTemplateForEntry(this.#getActiveEntry()) : null;
    const templateLodging = template
      ? (template.typeData?.lodgings ?? []).find(l => l.id === lodging.templateItemId) ?? null
      : null;
    const result = await LodgingEditApp.open(lodging, templateLodging);
    if (!result) return;
    innData.lodgings[index] = result;
    await this.#saveEntryData(this._activeTab, innData);
  }

  #getTemplateForEntry(entry) {
    if (!entry?.subTypeId) return null;
    const subTypes = game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES);
    return (subTypes[entry.typeId] ?? []).find(t => t.id === entry.subTypeId) ?? null;
  }

  #getActiveEntry() {
    return getTypeEntries(this._location).find(e => e.id === this._activeTab) ?? null;
  }

  static async #onDeleteLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    const lodging = innData.lodgings.find(l => l.id === lodgingId);
    if (!lodging) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.deleteLodgingTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.inn.deleteLodgingConfirm", { name: lodging.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    innData.lodgings = innData.lodgings.filter(l => l.id !== lodgingId);
    await this.#saveEntryData(this._activeTab, innData);
  }

  static async #onRentLodging(event, target) {
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const lodging = (this._location.typeData?.[this._activeTab]?.lodgings ?? []).find(l => l.id === lodgingId);
    if (!lodging) return;
    cartManager.addLodging({
      sceneId: canvas.scene?.id,
      locationId: this._location.id,
      locationName: this._location.name,
      entryId: this._activeTab,
      lodging
    });
    CartApp.open();
  }

  static async #onDismissLedgerEntry(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.entryId;
    if (!entryId) return;
    const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    const entry = innData.ledger.find(e => e.id === entryId);
    if (!entry) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.dismissEntryTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.inn.dismissEntryConfirm", { actor: entry.actorName ?? "?", lodging: entry.lodgingName ?? "?" })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.dismissEntryTitle"), icon: "fa-solid fa-times" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    // Cancelling a booking that hasn't already been reclaimed (e.g. an active stay ended early)
    // frees its room back up; expired/reclaimed bookings were already restored at expiry.
    if (!entry.reclaimed) restoreLodgingAvailability(innData, entry);
    innData.ledger = innData.ledger.filter(e => e.id !== entryId);
    await this.#saveEntryData(this._activeTab, innData);
  }

  static async #onEditBooking(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.entryId;
    if (!entryId) return;
    const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    const entry = innData.ledger.find(e => e.id === entryId);
    if (!entry) return;

    const { hoursPerDay } = getWorldTimeConfig();
    const secondsPerDay = hoursPerDay * 3600;
    const now = game.time.worldTime;
    const actors = game.actors.contents
      .map(a => ({ id: a.id, name: a.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const result = await BookingEditApp.open(entry, { lodgings: [], actors, secondsPerDay, now });
    if (!result) return;

    entry.actorId   = result.actorId;
    entry.actorName = result.actorName;

    const wasActive    = !entry.reclaimed;
    const willBeActive = result.days > 0;
    if (!wasActive && willBeActive) {
      consumeLodgingAvailability(innData, entry.lodgingId);
      entry.reclaimed = false;
    } else if (wasActive && !willBeActive) {
      restoreLodgingAvailability(innData, entry);
      entry.reclaimed = true;
    }
    entry.expiresAt = now + result.days * secondsPerDay;

    await this.#saveEntryData(this._activeTab, innData);
  }

  static async #onAddBooking() {
    if (!game.user.isGM) return;
    const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    if (!(innData.lodgings ?? []).length) return;

    const { hoursPerDay } = getWorldTimeConfig();
    const secondsPerDay = hoursPerDay * 3600;
    const now = game.time.worldTime;
    const lodgings = innData.lodgings.map(l => ({ id: l.id, name: l.name, beds: l.beds }));
    const actors = game.actors.contents
      .map(a => ({ id: a.id, name: a.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const result = await BookingEditApp.open(null, { lodgings, actors, secondsPerDay, now });
    if (!result) return;

    const lodging = innData.lodgings.find(l => l.id === result.lodgingId);
    if (!lodging) return;

    innData.ledger ??= [];
    innData.ledger.push({
      id:                foundry.utils.randomID(),
      lodgingId:         lodging.id,
      lodgingName:       lodging.name,
      beds:              lodging.beds,
      actorId:           result.actorId,
      actorName:         result.actorName,
      purchasedAt:       now,
      durationSeconds:   result.days * secondsPerDay,
      expiresAt:         now + result.days * secondsPerDay,
      reclaimed:         false
    });
    consumeLodgingAvailability(innData, lodging.id);

    await this.#saveEntryData(this._activeTab, innData);
  }

  static async #onRefreshCourse(event, target) {
    if (!game.user.isGM) return;
    const courseId = target.dataset.courseId;
    if (!courseId) return;
    const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    const course = (innData.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course || course.mode !== "random") return;
    const shuffled = [...(course.pool ?? [])].sort(() => Math.random() - 0.5);
    const dcMin = course.drawCountMin ?? course.drawCount ?? 1;
    const dcMax = course.drawCountMax ?? course.drawCount ?? dcMin;
    const dcCount = dcMin >= dcMax ? dcMin : Math.floor(Math.random() * (dcMax - dcMin + 1)) + dcMin;
    course.drawnItems    = shuffled.slice(0, Math.min(dcCount, shuffled.length));
    course.lastRefreshed = game.time.worldTime;
    await this.#saveEntryData(this._activeTab, innData);
  }

  static async #onBuyMenuItem(event, target) {
    const { courseId, itemId } = target.dataset;
    if (!courseId || !itemId) return;
    const inn = this._location.typeData?.[this._activeTab];
    if (!inn) return;
    const course = (inn.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course) return;
    const allItems = course.mode === "random" ? (course.drawnItems ?? []) : (course.items ?? []);
    const item = allItems.find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMenuItem({
      sceneId: canvas.scene?.id,
      locationId: this._location.id,
      locationName: this._location.name,
      course,
      item
    });
    CartApp.open();
  }

  static async #onBuyInventoryItem(event, target) {
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const item = (this._location.typeData?.[this._activeTab]?.inventory ?? []).find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMerchantItem({
      sceneId: canvas.scene?.id,
      locationId: this._location.id,
      locationName: this._location.name,
      entryId: this._activeTab,
      item
    });
    CartApp.open();
  }

  static async #onDeleteMerchantItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const merchant = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { inventory: [] });
    const item = merchant.inventory.find(i => i.id === itemId);
    if (!item) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.removeItemTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.merchant.removeItemConfirm", { name: item.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    merchant.inventory = merchant.inventory.filter(i => i.id !== itemId);
    await this.#saveEntryData(this._activeTab, merchant);
  }

  static async #onEditMerchantItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    const merchant = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { inventory: [] });
    const existing = merchant.inventory.find(i => i.id === itemId);
    if (!existing) return;
    const result = await MerchantItemEditApp.open(existing);
    if (!result) return;
    const idx = merchant.inventory.findIndex(i => i.id === itemId);
    if (idx !== -1) merchant.inventory[idx] = result;
    await this.#saveEntryData(this._activeTab, merchant);
  }

  static async #onRestoreFromMerchantTemplate() {
    if (!game.user.isGM) return;
    const entry    = this.#getActiveEntry();
    const template = this.#getTemplateForEntry(entry);
    if (!template) return;
    const merchantData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { inventory: [] });
    await MerchantRestoreDialog.open(merchantData, template, async (updated) => {
      await this.#saveEntryData(this._activeTab, updated);
    });
  }

  static async #onForceRestockMerchant() {
    if (!game.user.isGM) return;
    const merchant = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { inventory: [] });
    const currencies = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG).currencies ?? [];
    await rollMerchantRestock(merchant.inventory ?? [], merchant.stockType ?? "percent");
    applyPriceVariation(merchant.inventory ?? [], readPriceVarConfig(merchant), currencies);
    rollMerchantBuyRates(merchant.purchasingProfile ?? []);
    merchant.lastRestocked = game.time.worldTime;
    merchant.buybackItems  = [];
    await this.#saveEntryData(this._activeTab, merchant);
    ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.restocked"));
  }

  static async #onForceRefreshInn() {
    if (!game.user.isGM) return;
    const inn = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], menu: { courses: [] } });
    const currencies = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG).currencies ?? [];
    forceRefreshInn(inn, currencies);
    await this.#saveEntryData(this._activeTab, inn);
    ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.refreshed"));
  }

  static #onSwitchToSellTab() {
    this._sellTabActive = true;
    this.render();
  }

  static #onSwitchFromSellTab(event, target) {
    this._sellTabActive = false;
    this._activeTab = target.dataset.tabId ?? null;
    this.render();
  }

  static #onSelectSellActor(event, target) {
    this._sellActorId = target.value || null;
    this.render();
  }

  static async #onAddToSellCart(event, target) {
    const actorItemId = target.dataset.actorItemId;
    if (!actorItemId) return;
    const actor = this._sellActorId ? game.actors.get(this._sellActorId) : null;
    if (!actor) return;
    const actorItem = actor.items.get(actorItemId);
    if (!actorItem) return;

    const currencies      = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const effectiveProfile = mergePurchasingProfiles(this._location);
    const rule = findEffectiveRule(effectiveProfile, actorItem.type ?? "");
    if (!rule) return;
    const salePrice = computeSalePrice(actorItem, rule, currencies);
    if (!salePrice) return;

    const qtyInput = this.element.querySelector(`.ssm-sell-qty[data-actor-item-id="${actorItemId}"]`);
    const qty = Math.max(1, parseInt(qtyInput?.value) || 1);

    cartManager.addSellItem({
      sceneId:        canvas.scene?.id,
      locationId:     this._location.id,
      locationName:   this._location.name,
      actorId:        actor.id,
      actorName:      actor.name,
      actorItemId,
      itemName:       actorItem.name,
      itemLinkedUuid: actorItem.uuid,
      salePrice:      { amount: salePrice.amount * qty, currencyId: salePrice.currencyId }
    });
    CartApp.open();
  }

  static async #onBuyBackItem(event, target) {
    const buybackId = target.dataset.buybackId;
    const entryId   = target.dataset.entryId;
    if (!buybackId || !entryId) return;
    const buybackItems = this._location.typeData?.[entryId]?.buybackItems ?? [];
    const entry = buybackItems.find(b => b.id === buybackId);
    if (!entry || !entry.buybackPrice) return;
    cartManager.addMerchantItem({
      sceneId:      canvas.scene?.id,
      locationId:   this._location.id,
      locationName: this._location.name,
      entryId,
      item: {
        id:     entry.id,
        name:   entry.itemName,
        itemId: entry.itemLinkedUuid,
        price:  entry.buybackPrice
      }
    });
    CartApp.open();
  }


  static async #onDepositCoins() {
    if (!this._bankActorId) return;
    const actor = game.actors.get(this._bankActorId);
    if (!actor) return;
    const form = this.element.querySelector('.ssm-deposit-form');
    if (!form) return;

    const coins = {};
    for (const input of form.querySelectorAll('.ssm-deposit-amount-input')) {
      const amt = parseInt(input.value) || 0;
      if (amt > 0) coins[input.dataset.currencyId] = amt;
    }
    if (!Object.keys(coins).length) return;

    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];
    const bankRaw        = this._location.typeData?.[this._activeTab] ?? {};
    const depositSettings = bankRaw.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 };
    const feeRate        = depositSettings.depositFee ?? 0;

    if (feeRate > 0) {
      const totalStd = totalOfferedInStandard(coins, currencies);
      const feeStd   = totalStd * feeRate / 100;
      const maxDenom = currencies.reduce((m, c) => Math.max(m, parseExchangeRate(c.exchangeRate)), 0);
      const feeCoins = calculateChange(feeStd, currencies, maxDenom) ?? {};
      const feeLabel = formatAmounts(feeCoins, currencies);
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        title:   game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.feeConfirmTitle"),
        content: game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.feeConfirmBody", { fee: feeLabel }),
        yes:     { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.depositButton") },
        no:      { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.cancelButton") }
      });
      if (!confirmed) return;
      await removeCoinsFromActor(actor, feeCoins, currencies, currencyConfig.mode ?? 'loose');
    } else {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        title:   game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.confirmTitle"),
        content: game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.confirmBody", { coins: formatAmounts(coins, currencies) }),
        yes:     { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.depositButton") },
        no:      { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.cancelButton") }
      });
      if (!confirmed) return;
    }

    await removeCoinsFromActor(actor, coins, currencies, currencyConfig.mode ?? 'loose');

    const { hoursPerDay } = getWorldTimeConfig();
    const deposit = {
      id:                foundry.utils.randomID(),
      actorId:           actor.id,
      actorName:         actor.name,
      coins,
      depositedAt:       game.time.worldTime,
      minDepositSeconds: (depositSettings.minDepositDays ?? 0) * hoursPerDay * 3600
    };

    const payload = {
      deposit,
      locationId: this._location.id,
      entryId:    this._activeTab,
      sceneId:    canvas.scene?.id,
      isGlobal:   depositSettings.global ?? false,
      userId:     game.user.id
    };

    if (game.user.isGM) {
      await _handleRecordDeposit(payload);
    } else {
      game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.RECORD_DEPOSIT, payload });
    }

    for (const input of form.querySelectorAll('.ssm-deposit-amount-input')) input.value = '';
    this.render();
  }

  static async #onWithdrawDeposit(event, target) {
    if (!this._bankActorId) return;
    const actor = game.actors.get(this._bankActorId);
    if (!actor) return;

    let depositIds;
    try { depositIds = JSON.parse(target.dataset.depositIds); } catch { return; }
    if (!depositIds?.length) return;

    const currencyConfig  = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies      = currencyConfig.currencies ?? [];
    const bankRaw         = this._location.typeData?.[this._activeTab] ?? {};
    const depositSettings = bankRaw.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 };
    const allDeposits     = depositSettings.global
      ? (game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [])
      : (bankRaw.deposits ?? []);

    const matching = allDeposits.filter(d => depositIds.includes(d.id));
    if (!matching.length) return;

    const mergedCoins = {};
    for (const d of matching) for (const [cId, amt] of Object.entries(d.coins)) mergedCoins[cId] = (mergedCoins[cId] ?? 0) + amt;
    const now = game.time.worldTime;
    const isMergedMatured = matching.every(d => now >= d.depositedAt + d.minDepositSeconds);
    const representativeDeposit = {
      id:                matching[0].id,
      coins:             mergedCoins,
      depositedAt:       isMergedMatured ? 0 : matching[0].depositedAt,
      minDepositSeconds: isMergedMatured ? 0 : matching[0].minDepositSeconds
    };

    const result = await WithdrawalDialog.open({
      deposit:         representativeDeposit,
      depositSettings,
      currencies,
      worldTime:       now
    });
    if (!result?.withdrawCoins) return;

    const payload = {
      depositIds,
      withdrawCoins:  result.withdrawCoins,
      actorId:        actor.id,
      earlyFeeRate:   depositSettings.earlyWithdrawalFee ?? 0,
      locationId:     this._location.id,
      entryId:        this._activeTab,
      sceneId:        canvas.scene?.id,
      isGlobal:       depositSettings.global ?? false,
      userId:         game.user.id
    };

    if (game.user.isGM) {
      await _handleProcessWithdrawal(payload);
    } else {
      game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.PROCESS_WITHDRAWAL, payload });
    }

    this.render();
  }

  static async #onEditDeposit(event, target) {
    if (!game.user.isGM) return;

    let depositIds;
    try { depositIds = JSON.parse(target.dataset.depositIds); } catch { return; }
    if (!depositIds?.length) return;

    const currencyConfig  = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies      = currencyConfig.currencies ?? [];
    const bankRaw         = this._location.typeData?.[this._activeTab] ?? {};
    const depositSettings = bankRaw.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 };
    const isGlobal        = depositSettings.global ?? false;
    const allDeposits     = isGlobal
      ? (game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [])
      : (bankRaw.deposits ?? []);

    const matching = allDeposits.filter(d => depositIds.includes(d.id));
    if (!matching.length) return;

    const mergedCoins = {};
    for (const d of matching) for (const [cId, amt] of Object.entries(d.coins)) mergedCoins[cId] = (mergedCoins[cId] ?? 0) + amt;
    const now = game.time.worldTime;
    const isMergedMatured = matching.every(d => now >= d.depositedAt + d.minDepositSeconds);
    const { hoursPerDay } = getWorldTimeConfig();
    const secondsPerDay = hoursPerDay * 3600;

    const row = {
      id:                matching[0].id,
      targetIds:         depositIds,
      actorId:           matching[0].actorId,
      actorName:         matching[0].actorName,
      coins:             mergedCoins,
      matured:           isMergedMatured,
      depositedAt:       matching[0].depositedAt,
      minDepositSeconds: matching[0].minDepositSeconds
    };

    const actors = game.actors.contents
      .map(a => ({ id: a.id, name: a.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const result = await DepositEditApp.open(row, { currencies, actors, secondsPerDay, now });
    if (!result) return;

    await _handleEditDeposit({
      targetIds:      depositIds,
      updatedDeposit: result.updatedDeposit,
      locationId:     this._location.id,
      entryId:        this._activeTab,
      sceneId:        canvas.scene?.id,
      isGlobal
    });

    this.render();
  }

  static async #onResetBankSettings() {
    if (!game.user.isGM) return;
    const bankData    = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? {});
    const activeEntry = this.#getActiveEntry();
    const subType     = activeEntry?.subTypeId
      ? ((game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES))[LOCATION_TYPE_IDS.BANK] ?? []).find(s => s.id === activeEntry.subTypeId)
      : null;
    restoreFields(bankData, subType?.typeData?.bank ?? {}, TEMPLATE_FIELDS.bank);
    await this.#saveEntryData(this._activeTab, bankData);
  }

  // --- Loans -------------------------------------------------------------------------------

  static async #onCreateLoanOffer() {
    if (!game.user.isGM) return;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];
    const result = await LoanOfferApp.open({ currencies, defaultActorId: this._bankActorId });
    if (!result) return;

    const { hoursPerDay } = getWorldTimeConfig();
    const secondsPerDay = hoursPerDay * 3600;
    const principalStandard = totalOfferedInStandard(result.principalCoins, currencies);
    const now = game.time.worldTime;
    const loan = {
      id:              foundry.utils.randomID(),
      actorId:         result.actorId,
      actorName:       result.actorName,
      status:          "offered",
      principalCoins:  result.principalCoins,
      principalStandard,
      balanceStandard: principalStandard,
      interestRate:    result.interestRate,
      periodUnit:      result.periodUnit,
      periodSeconds:   periodSecondsFor(result.periodUnit, secondsPerDay),
      offeredAt:       now,
      acceptedAt:      null,
      lastAccrualAt:   null
    };

    const bank = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? {});
    bank.loans = [...(bank.loans ?? []), loan];
    this._bankActorId = result.actorId; // surface the new offer immediately
    await this.#saveEntryData(this._activeTab, bank);
    ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.offerCreated"));
  }

  static async #onAcceptLoan(event, target) {
    const loanId = target.dataset.loanId;
    if (!loanId) return;
    const loan = (this._location.typeData?.[this._activeTab]?.loans ?? []).find(l => l.id === loanId);
    if (!loan) return;
    const currencies = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG).currencies) ?? [];
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      title:   game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.acceptConfirmTitle"),
      content: game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.loans.acceptConfirmBody", {
        amount: formatAmounts(loan.principalCoins ?? {}, currencies),
        rate:   loan.interestRate,
        period: game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.bank.loans.period.${loan.periodUnit}`)
      })
    });
    if (!confirmed) return;

    const payload = { loanId, locationId: this._location.id, entryId: this._activeTab, sceneId: canvas.scene?.id, userId: game.user.id };
    if (game.user.isGM) await _handleAcceptLoan(payload);
    else game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.ACCEPT_LOAN, payload });
    this.render();
  }

  static async #onDeclineLoan(event, target) {
    const loanId = target.dataset.loanId;
    if (!loanId) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      title:   game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.declineConfirmTitle"),
      content: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.declineConfirmBody")
    });
    if (!confirmed) return;

    const payload = { loanId, locationId: this._location.id, entryId: this._activeTab, sceneId: canvas.scene?.id, userId: game.user.id };
    if (game.user.isGM) await _handleDeclineLoan(payload);
    else game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.DECLINE_LOAN, payload });
    this.render();
  }

  static async #onRepayLoan(event, target) {
    const loanId = target.dataset.loanId;
    const loan = (this._location.typeData?.[this._activeTab]?.loans ?? []).find(l => l.id === loanId);
    if (!loan) return;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];
    const mode           = currencyConfig.mode ?? 'loose';
    const container = target.closest('.ssm-loan-entry');
    const payCoins = {};
    container?.querySelectorAll('.ssm-loan-pay-input').forEach(input => {
      const amt = parseInt(input.value) || 0;
      if (amt > 0) payCoins[input.dataset.currencyId] = amt;
    });
    await this.#submitRepayment(loan, payCoins, currencies, mode);
  }

  static async #onPayOffLoan(event, target) {
    const loanId = target.dataset.loanId;
    const loan = (this._location.typeData?.[this._activeTab]?.loans ?? []).find(l => l.id === loanId);
    if (!loan) return;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];
    const mode           = currencyConfig.mode ?? 'loose';
    const actor   = game.actors.get(loan.actorId);
    const accrued = accrueLoan(loan, game.time.worldTime);
    const { coins, shortfall } = selectPayoffCoins(actor, accrued.balanceStandard, currencies, mode);
    if (shortfall > 1e-6) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.insufficientPayoff"));
      return;
    }
    await this.#submitRepayment(loan, coins, currencies, mode);
  }

  /** Shared by repay (from inputs) and pay-off-in-full: verify funds, confirm (with any change), debit, dispatch. */
  async #submitRepayment(loan, payCoins, currencies, mode) {
    const filtered = {};
    for (const [cId, amt] of Object.entries(payCoins ?? {})) {
      const n = Math.max(0, Math.floor(amt));
      if (n > 0) filtered[cId] = n;
    }
    if (!Object.keys(filtered).length) return;
    const actor = game.actors.get(loan.actorId);
    if (!actor) return;

    const short = insufficientCurrencies(actor, filtered, currencies, mode);
    if (short.length) {
      ui.notifications.warn(game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.loans.insufficientFunds", { coins: short.join(", ") }));
      return;
    }

    // Preview any change: an overpayment beyond the (accrued) balance is returned to the player,
    // denominated no larger than the highest coin they paid with.
    const owedStandard = accrueLoan(loan, game.time.worldTime).balanceStandard;
    const changeStandard = totalOfferedInStandard(filtered, currencies) - owedStandard;
    let changeLabel = "";
    if (changeStandard > 1e-6) {
      const paidRates = Object.keys(filtered).map(cId => parseExchangeRate(currencies.find(c => c.id === cId)?.exchangeRate));
      const maxDenom  = paidRates.length ? Math.max(...paidRates) : getMaxDenomValue(currencies);
      changeLabel = formatAmounts(calculateChange(changeStandard, currencies, maxDenom) ?? {}, currencies);
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      title:   game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.payConfirmTitle"),
      content: changeLabel
        ? game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.loans.payConfirmBodyChange", { coins: formatAmounts(filtered, currencies), change: changeLabel })
        : game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.loans.payConfirmBody", { coins: formatAmounts(filtered, currencies) })
    });
    if (!confirmed) return;

    await removeCoinsFromActor(actor, filtered, currencies, mode);

    const payload = { loanId: loan.id, payCoins: filtered, locationId: this._location.id, entryId: this._activeTab, sceneId: canvas.scene?.id, userId: game.user.id };
    if (game.user.isGM) await _handleRepayLoan(payload);
    else game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.REPAY_LOAN, payload });
    this.render();
  }

  static async #onCancelLoan(event, target) {
    if (!game.user.isGM) return;
    const loanId = target.dataset.loanId;
    const bank = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? {});
    if (!(bank.loans ?? []).some(l => l.id === loanId)) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      title:   game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.cancelConfirmTitle"),
      content: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.cancelConfirmBody")
    });
    if (!confirmed) return;
    bank.loans = (bank.loans ?? []).filter(l => l.id !== loanId);
    await this.#saveEntryData(this._activeTab, bank);
  }

  static async #onEditLoan(event, target) {
    if (!game.user.isGM) return;
    const loanId = target.dataset.loanId;
    const bank = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? {});
    const loans = bank.loans ?? [];
    const loan = loans.find(l => l.id === loanId);
    if (!loan) return;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];
    const result = await LoanOfferApp.open({ currencies, loan });
    if (!result) return;

    const { hoursPerDay } = getWorldTimeConfig();
    const secondsPerDay = hoursPerDay * 3600;
    const principalStandard = totalOfferedInStandard(result.principalCoins, currencies);
    const updated = {
      ...loan,
      actorId:         result.actorId,
      actorName:       result.actorName,
      principalCoins:  result.principalCoins,
      principalStandard,
      balanceStandard: principalStandard, // GM edit re-bases the owed amount to the new principal
      interestRate:    result.interestRate,
      periodUnit:      result.periodUnit,
      periodSeconds:   periodSecondsFor(result.periodUnit, secondsPerDay)
    };
    bank.loans = loans.map(l => l.id === loanId ? updated : l);
    await this.#saveEntryData(this._activeTab, bank);
  }

  #wireActorWidgets() {
    this.#actorWidgetAbort?.abort();
    this.#actorWidgetAbort = new AbortController();
    const { signal } = this.#actorWidgetAbort;

    for (const el of this.#actorDropdownEls) el.remove();
    this.#actorDropdownEls = [];
    document.querySelector('.ssm-actor-filter-menu')?.remove();

    const bankWidget = this.element.querySelector('.ssm-actor-dropdown-widget[data-actor-context="bank"]');
    if (bankWidget) {
      this.#wireActorDropdown(bankWidget, signal, id => {
        this._bankActorId = id;
        this.render();
      });
    }
    const bankFilterBtn = this.element.querySelector('.ssm-actor-filter-btn[data-actor-context="bank"]');
    if (bankFilterBtn) {
      this.#wireActorFilterMenu(bankFilterBtn, this._bankActorFilter, signal, f => {
        this._bankActorFilter = f;
        this.render();
      });
    }

    const sellWidget = this.element.querySelector('.ssm-actor-dropdown-widget[data-actor-context="sell"]');
    if (sellWidget) {
      this.#wireActorDropdown(sellWidget, signal, id => {
        this._sellActorId = id;
        this.render();
      });
    }
    const sellFilterBtn = this.element.querySelector('.ssm-actor-filter-btn[data-actor-context="sell"]');
    if (sellFilterBtn) {
      this.#wireActorFilterMenu(sellFilterBtn, this._sellActorFilter, signal, f => {
        this._sellActorFilter = f;
        this.render();
      });
    }
  }

  #wireActorDropdown(widget, signal, onSelect) {
    const trigger = widget.querySelector('.ssm-actor-dropdown-trigger');
    const list    = widget.querySelector('.ssm-actor-dropdown-list');
    if (!trigger || !list) return;

    document.body.appendChild(list);
    this.#actorDropdownEls.push(list);

    const position = () => {
      const r = trigger.getBoundingClientRect();
      list.style.top      = `${r.bottom + 2}px`;
      list.style.left     = `${r.left}px`;
      list.style.minWidth = `${r.width}px`;
    };
    const open  = () => { position(); list.classList.add('is-open'); list.querySelector('.ssm-actor-dropdown-search')?.focus(); };
    const close = () => list.classList.remove('is-open');

    trigger.addEventListener('click', e => { e.stopPropagation(); list.classList.contains('is-open') ? close() : open(); }, { signal });
    document.addEventListener('click', close, { signal });
    list.addEventListener('click', e => e.stopPropagation(), { signal });

    list.querySelector('.ssm-actor-dropdown-search')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      list.querySelectorAll('.ssm-actor-option').forEach(opt => {
        if (opt.classList.contains('ssm-actor-option-empty')) { opt.style.display = ''; return; }
        opt.style.display = (!q || opt.textContent.trim().toLowerCase().includes(q)) ? '' : 'none';
      });
    }, { signal });

    list.querySelectorAll('.ssm-actor-option').forEach(opt => {
      opt.addEventListener('click', () => { onSelect(opt.dataset.actorId || null); close(); }, { signal });
    });
  }

  #wireActorFilterMenu(btn, actorFilter, signal, onApply) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelector('.ssm-actor-filter-menu')?.remove();

      const types = Object.entries(CONFIG.Actor.typeLabels ?? {}).map(([id, label]) => ({
        id,
        label: typeof label === 'string' ? game.i18n.localize(label) : id,
        checked: !actorFilter.types || actorFilter.types.has(id)
      }));

      const menu = document.createElement('div');
      menu.className = 'ssm-actor-filter-menu';
      menu.innerHTML = `
        <label class="ssm-af-row"><input type="checkbox" class="ssm-af-player-owned"${actorFilter.playerOwned ? ' checked' : ''}> ${game.i18n.localize('SANDBOX_SETTLEMENT_MANAGER.actor.playerOwned')}</label>
        <hr class="ssm-af-divider">
        ${types.map(t => `<label class="ssm-af-row"><input type="checkbox" class="ssm-af-type" data-type="${t.id}"${t.checked ? ' checked' : ''}> ${t.label}</label>`).join('')}
      `;

      const rect = btn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top  = `${rect.bottom + 2}px`;
      menu.style.left = `${rect.left}px`;
      document.body.appendChild(menu);

      menu.addEventListener('click', e => e.stopPropagation());
      menu.addEventListener('change', () => {
        const playerOwned  = menu.querySelector('.ssm-af-player-owned')?.checked ?? true;
        const typeCbs      = [...menu.querySelectorAll('.ssm-af-type')];
        const allChecked   = typeCbs.every(cb => cb.checked);
        const checkedTypes = typeCbs.filter(cb => cb.checked).map(cb => cb.dataset.type);
        onApply({ playerOwned, types: allChecked ? null : (checkedTypes.length ? new Set(checkedTypes) : null) });
      });

      document.addEventListener('click', () => menu.remove(), { once: true, signal });
    }, { signal });
  }

  static async #onAddExchangeToCart(event, target) {
    if (!this._bankActorId) return;
    const section = this.element.querySelector('.ssm-bank-exchange');
    if (!section) return;
    const fromAmount     = parseInt(section.querySelector('[data-field="fromAmount"]')?.value) || 0;
    const fromCurrencyId = section.querySelector('[data-field="fromCurrency"]')?.value ?? "";
    const toCurrencyId   = section.querySelector('[data-field="toCurrency"]')?.value ?? "";
    if (!fromAmount || !fromCurrencyId || !toCurrencyId || fromCurrencyId === toCurrencyId) return;

    const currencies   = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const bankData     = this._location.typeData?.[this._activeTab] ?? {};
    const actor        = game.actors.get(this._bankActorId);
    if (!actor) return;

    cartManager.addExchange({
      sceneId:        canvas.scene?.id,
      locationId:     this._location.id,
      locationName:   this._location.name,
      actorId:        actor.id,
      actorName:      actor.name,
      fromCurrencyId,
      fromAmount,
      toCurrencyId,
      feeRatePercent: bankData.exchangeFee ?? 0
    });
    CartApp.open();
    const amtInput = section.querySelector('[data-field="fromAmount"]');
    if (amtInput) amtInput.value = '';
  }
}
