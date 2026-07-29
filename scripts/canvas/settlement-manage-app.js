import { MODULE_ID, FLAGS, SETTINGS, LOCATION_TYPE_IDS, CORE_LOCATION_TYPES, getTypeEntries } from "../constants.js";
import { LocationEditApp } from "./location-edit-app.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { cartManager } from "./cart-manager.js";
import { CartApp } from "./cart-app.js";
import { TemplateRestoreDialog } from "./inn/template-restore-dialog.js";
import { PurchaseDialog } from "./purchase-dialog.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { calculateChange, formatAmounts, parseExchangeRate, totalOfferedInStandard, removeCoinsFromActor, getMaxDenomValue } from "../utils/currency-utils.js";
import { MerchantItemEditApp } from "./merchant-item-edit-app.js";
import { SOCKET_CHANNEL, SOCKET_TYPES, _handleRecordDeposit, _handleProcessWithdrawal, _handleEditDeposit, _handleAcceptLoan, _handleDeclineLoan, _handleRepayLoan } from "../socket.js";
import { DepositEditApp } from "./deposit-edit-app.js";
import { LoanOfferApp } from "./loan-offer-app.js";
import { periodSecondsFor, accrueLoan, insufficientCurrencies, selectPayoffCoins } from "../utils/loan-utils.js";
import { WithdrawalDialog } from "./withdrawal-dialog.js";
import { mergePurchasingProfiles, findEffectiveRule, computeSalePrice } from "./purchasing-utils.js";
import { MerchantRestoreDialog } from "./merchant-restore-dialog.js";
import { restoreFields, TEMPLATE_FIELDS } from "./template-link.js";
import { buildMerchantData, buildBankData, buildInnData, buildSellData, buildEntryTypeData, rollMerchantRestock, applyPriceVariation, rollMerchantBuyRates, readPriceVarConfig } from "./location-data.js";
import { SubTypeEditApp } from "../settings/sub-type-edit.js";
import { restoreLodgingAvailability, consumeLodgingAvailability } from "./lodging-utils.js";
import { BookingEditApp } from "./inn/booking-edit-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class SettlementManageApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _selectedLocationId = null;
  _activeTab = null;
  _sellTabActive = false;
  _sellActorId   = null;
  _bankActorId   = null;
  _sceneUpdateHook = null;
  _worldTimeHook   = null;
  _showLedger = false;
  _bankActorFilter = { playerOwned: true, types: null };
  _sellActorFilter = { playerOwned: true, types: null };
  #pickerAbort = null;
  #pickerDropdown = null;
  #actorWidgetAbort = null;
  #actorDropdownEls = [];

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-settlement-manage`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.manage.title", resizable: true },
    position: { width: 750, height: 560 },
    actions: {
      addLocation:        SettlementManageApp.#onAddLocation,
      deleteLocation:     SettlementManageApp.#onDeleteLocation,
      toggleDiscovered:   SettlementManageApp.#onToggleDiscovered,
      selectLocation:     SettlementManageApp.#onSelectLocation,
      switchTab:          SettlementManageApp.#onSwitchTab,
      editLocationEntry:  SettlementManageApp.#onEditLocationEntry,
      deleteTypeEntry:    SettlementManageApp.#onDeleteTypeEntry,
      removeTypeEntry:    SettlementManageApp.#onRemoveTypeEntry,
      editLodging:        SettlementManageApp.#onEditLodging,
      deleteLodging:      SettlementManageApp.#onDeleteLodging,
      rentLodging:        SettlementManageApp.#onRentLodging,
      dismissLedgerEntry: SettlementManageApp.#onDismissLedgerEntry,
      editBooking:        SettlementManageApp.#onEditBooking,
      addBooking:         SettlementManageApp.#onAddBooking,
      refreshCourse:        SettlementManageApp.#onRefreshCourse,
      buyMenuItem:          SettlementManageApp.#onBuyMenuItem,
      restoreFromTemplate:         SettlementManageApp.#onRestoreFromTemplate,
      restoreFromMerchantTemplate: SettlementManageApp.#onRestoreFromMerchantTemplate,
      forceRestockMerchant:        SettlementManageApp.#onForceRestockMerchant,
      addMerchantItem:             SettlementManageApp.#onAddMerchantItem,
      deleteMerchantItem:     SettlementManageApp.#onDeleteMerchantItem,
      editMerchantItem:       SettlementManageApp.#onEditMerchantItem,
      switchToSellTab:        SettlementManageApp.#onSwitchToSellTab,
      addToSellCart:          SettlementManageApp.#onAddToSellCart,
      buyBackItem:            SettlementManageApp.#onBuyBackItem,
      addExchangeToCart:      SettlementManageApp.#onAddExchangeToCart,
      depositCoins:           SettlementManageApp.#onDepositCoins,
      withdrawDeposit:        SettlementManageApp.#onWithdrawDeposit,
      editDeposit:            SettlementManageApp.#onEditDeposit,
      resetBankSettings:      SettlementManageApp.#onResetBankSettings,
      createLoanOffer:        SettlementManageApp.#onCreateLoanOffer,
      acceptLoan:             SettlementManageApp.#onAcceptLoan,
      declineLoan:            SettlementManageApp.#onDeclineLoan,
      repayLoan:              SettlementManageApp.#onRepayLoan,
      payOffLoan:             SettlementManageApp.#onPayOffLoan,
      cancelLoan:             SettlementManageApp.#onCancelLoan,
      editLoan:               SettlementManageApp.#onEditLoan,
      settlementLedger:       SettlementManageApp.#onSettlementLedger,
      clearLedger:            SettlementManageApp.#onClearLedger,
      exportLedgerCsv:        SettlementManageApp.#onExportLedgerCsv
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/settlement-manage.hbs` }
  };

  // ------------------------------------------------------------------ context

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const scene = canvas.scene;
    const isGM = game.user.isGM;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];

    context.isGM         = isGM;
    context.settlementName     = scene?.getFlag(MODULE_ID, FLAGS.SETTLEMENT_NAME) ?? "";
    context.settlementTypes    = game.settings.get(MODULE_ID, SETTINGS.SETTLEMENT_TYPES)
      .map(t => ({ value: t.name, label: t.name }));
    context.selectedType = scene?.getFlag(MODULE_ID, FLAGS.SETTLEMENT_TYPE) ?? "";
    context.locations    = this.#enrichLocations(isGM);
    context.showLedger = this._showLedger;
    if (this._showLedger) {
      const { hoursPerDay } = getWorldTimeConfig();
      const secondsPerDay = hoursPerDay * 3600;
      const rawLedger = scene?.getFlag(MODULE_ID, FLAGS.LEDGER) ?? [];
      const byLoc = new Map();
      for (const e of rawLedger) {
        const key = e.locationId ?? '';
        if (!byLoc.has(key)) byLoc.set(key, { locationName: e.locationName || '(Unknown)', entries: [] });
        byLoc.get(key).entries.push(e);
      }
      const sc = currencies.find(c => c.isStandard);
      const stdRate = parseExchangeRate(sc?.exchangeRate ?? "1:1");
      context.ledgerGroups = [...byLoc.values()].map(g => ({
        locationName: g.locationName,
        entries: g.entries.map(e => {
          const curr = currencies.find(c => c.id === e.currencyId);
          const isSell = e.transactionType === 'sellItem';
          const absAmt = Math.abs(e.amount);
          const qtyLabel = e.quantityUnit
            ? `${e.quantity} ${e.quantityUnit}`
            : (e.quantity > 1 ? `×${e.quantity}` : '');
          return {
            ...e,
            amountLabel: `${isSell ? '−' : ''}${absAmt} ${curr?.abbreviation ?? '?'}`,
            dayLabel: `Day ${Math.floor(e.timestamp / secondsPerDay) + 1}`,
            qtyLabel
          };
        })
      }));
      const totalStd = rawLedger.reduce((s, e) => s + e.standardAmount, 0);
      const totalBreakdown = calculateChange(Math.abs(totalStd), currencies, stdRate);
      context.ledgerTotalLabel = (totalBreakdown && Object.values(totalBreakdown).some(v => v > 0))
        ? formatAmounts(totalBreakdown, currencies)
        : (sc ? `${Math.ceil(Math.abs(totalStd))} ${sc.abbreviation}` : '—');
      context.hasLedgerEntries = rawLedger.length > 0;
    }
    context.selectedLocation = this._showLedger ? null : await this.#buildSelectedLocationContext(currencies, isGM);
    return context;
  }

  #enrichLocations(isGM = true) {
    const all = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
    const instances = isGM ? all : all.filter(r => r.discovered?.default === true);
    return instances.map(r => {
      const entries = getTypeEntries(r);
      const seenTypeIds = new Set();
      const types = entries
        .filter(e => !seenTypeIds.has(e.typeId) && seenTypeIds.add(e.typeId))
        .map(e => CORE_LOCATION_TYPES.find(t => t.id === e.typeId))
        .filter(Boolean);
      return {
        ...r,
        typeName: types.map(t => t.name).join(" · ")
          || game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.unknownType"),
        typeIcon: types[0]?.icon ?? "fa-solid fa-question",
        selected: r.id === this._selectedLocationId
      };
    });
  }

  async #buildSelectedLocationContext(currencies, isGM = true) {
    const location = this.#syncSelectedLocation();
    if (!location) return null;

    const rawEntries  = getTypeEntries(location);
    const subTypeMap  = this.#getSubTypeMap();
    const selectedSet = new Set(rawEntries.map(e => `${e.typeId}::${e.subTypeId ?? ""}`));

    const typeEntries = rawEntries.map((entry, index) => {
      const coreType = CORE_LOCATION_TYPES.find(t => t.id === entry.typeId);
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

    const pickerGroups = CORE_LOCATION_TYPES.map(t => {
      const allSubTypes   = subTypeMap[t.id] ?? [];
      const availSubTypes = allSubTypes
        .filter(s => !selectedSet.has(`${t.id}::${s.id}`))
        .map(s => ({ id: s.id, name: s.name }));
      const typeItselfAvailable = !selectedSet.has(`${t.id}::`);
      return { typeId: t.id, name: t.name, icon: t.icon, typeItselfAvailable, subTypes: availSubTypes };
    }).filter(g => g.typeItselfAvailable || g.subTypes.length > 0);

    if (!this._activeTab || !rawEntries.some(e => e.id === this._activeTab)) {
      this._activeTab = rawEntries[0]?.id ?? null;
    }
    const tabs = await Promise.all(rawEntries.map(async entry => {
      const coreType   = CORE_LOCATION_TYPES.find(t => t.id === entry.typeId);
      const isInn      = entry.typeId === LOCATION_TYPE_IDS.INN;
      const isMerchant = entry.typeId === LOCATION_TYPE_IDS.MERCHANT;
      const isBank     = entry.typeId === LOCATION_TYPE_IDS.BANK;
      const subType    = entry.subTypeId
        ? (subTypeMap[entry.typeId] ?? []).find(s => s.id === entry.subTypeId) ?? null
        : null;
      const innData = isInn ? buildInnData(entry, location, currencies, isGM) : null;
      if (innData?._needsSave && isGM) this.#saveEntryData(entry.id, innData._updatedInn).catch(err => console.error(`${MODULE_ID} | Failed to save inn menu refresh`, err));

      const bankData = isBank ? buildBankData(this, entry, location, currencies) : null;

      let merchantData = null;
      if (isMerchant) {
        merchantData = await buildMerchantData(entry, location, currencies, isGM);
        if (merchantData._needsSave && isGM) this.#saveEntryData(entry.id, merchantData._updatedMerchant).catch(err => console.error(`${MODULE_ID} | Failed to save merchant restock`, err));
      }

      return {
        id: entry.id, active: entry.id === this._activeTab,
        name:        coreType?.name ?? entry.typeId,
        subTypeName: subType?.name ?? null,
        icon:        coreType?.icon ?? "fa-solid fa-question",
        typeId: entry.typeId, isInn, isMerchant, isBank,
        isOther: !isInn && !isMerchant && !isBank,
        innData, bankData, merchantData
      };
    }));

    const activeEntry = rawEntries.find(e => e.id === this._activeTab);
    const activeTemplate = isGM && activeEntry ? this.#getTemplateForEntry(activeEntry) : null;
    const innTemplate      = activeEntry?.typeId === LOCATION_TYPE_IDS.INN      ? activeTemplate : null;
    const merchantTemplate = activeEntry?.typeId === LOCATION_TYPE_IDS.MERCHANT ? activeTemplate : null;

    const effectiveProfile = mergePurchasingProfiles(location);
    const hasSellTab = effectiveProfile.length > 0;
    let sellData = null;
    if (hasSellTab) {
      sellData = await buildSellData(this, location, currencies, isGM, effectiveProfile);
    }
    const sellTabActive = this._sellTabActive && hasSellTab;
    if (sellTabActive) {
      tabs.forEach(t => { t.active = false; });
    }

    return {
      id: location.id,
      name: location.name,
      isGM,
      pickerGroups,
      hasAvailableTypes: isGM && pickerGroups.length > 0,
      hasInnTemplate:      !!innTemplate,
      hasMerchantTemplate: !!merchantTemplate,
      hasSellTab, sellTabActive, sellData,
      tabs,
      hasTabs:         tabs.length > 0 || hasSellTab,
      hasMultipleTabs: tabs.length > 1 || hasSellTab,
      hasDetails:      tabs.length > 0 || hasSellTab
    };
  }

  #getTemplateForEntry(entry) {
    if (!entry?.subTypeId) return null;
    const subTypes = this.#getSubTypeMap();
    return (subTypes[entry.typeId] ?? []).find(t => t.id === entry.subTypeId) ?? null;
  }

  #getActiveEntry() {
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return null;
    return getTypeEntries(location).find(e => e.id === this._activeTab) ?? null;
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

  // ------------------------------------------------------------------ render

  async _onRender(context, options) {
    await super._onRender(context, options);

    if (game.user.isGM) {
      this.element.querySelector('[name="settlementName"]')?.addEventListener("change", e => {
        canvas.scene?.setFlag(MODULE_ID, FLAGS.SETTLEMENT_NAME, e.target.value);
      });
      this.element.querySelector('[name="settlementType"]')?.addEventListener("change", e => {
        canvas.scene?.setFlag(MODULE_ID, FLAGS.SETTLEMENT_TYPE, e.target.value);
      });
      this.element.querySelector('[name="locationName"]')?.addEventListener("change", async e => {
        const location = this.#syncSelectedLocation();
        if (!location) return;
        const name = e.target.value.trim();
        if (!name) return;
        location.name = name;
        await this.#saveLocationData(location);
      });
      this.#setupTypePicker();
    }

    if (!this._sceneUpdateHook) {
      this._sceneUpdateHook = Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas.scene?.id) return;
        const locationsChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.LOCATIONS}`);
        const settlementTypeChanged  = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.SETTLEMENT_TYPE}`);
        if (!locationsChanged && !settlementTypeChanged) return;
        this.render({ parts: ["content"] });
      });
    }

    if (!this._worldTimeHook && game.user.isGM) {
      // Debounce so advancing/scrubbing world time doesn't trigger a render (and its fromUuid pass) per tick.
      const debounced = foundry.utils.debounce(() => this.render({ parts: ["content"] }), 250);
      this._worldTimeHook = Hooks.on("updateWorldTime", () => debounced());
    }

    this.#wireActorWidgets();

    // Wire bank exchange live preview
    const exchangeSection = this.element.querySelector('.ssm-bank-exchange');
    if (exchangeSection) this.#wireExchangePreview(exchangeSection);

    // Wire merchant item sheet links
    this.element.querySelectorAll(".ssm-item-link[data-uuid]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const item = await fromUuid(btn.dataset.uuid).catch(() => null);
        item?.sheet?.render(true);
      });
    });

    // Wire merchant inventory filter
    this.element.querySelectorAll(".merchant-filter-input").forEach(input => {
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        const section = input.closest(".inn-section");
        if (!section) return;
        section.querySelectorAll(".merchant-type-group").forEach(group => {
          let anyVisible = false;
          group.querySelectorAll("tbody tr").forEach(row => {
            const name = (row.querySelector(".col-name")?.textContent ?? "").toLowerCase();
            const match = !q || name.includes(q);
            row.hidden = !match;
            if (match) anyVisible = true;
          });
          group.hidden = !anyVisible;
        });
        section.querySelectorAll(".merchant-inventory-table").forEach(table => {
          if (table.closest(".merchant-type-group")) return;
          table.querySelectorAll("tbody tr").forEach(row => {
            const name = (row.querySelector(".col-name")?.textContent ?? "").toLowerCase();
            row.hidden = !q || !name.includes(q);
          });
        });
      });
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#actorWidgetAbort?.abort();
    for (const el of this.#actorDropdownEls) el.remove();
    this.#actorDropdownEls = [];
    document.querySelector('.ssm-actor-filter-menu')?.remove();
    this.#pickerAbort?.abort();
    this.#pickerDropdown?.remove();
    this.#pickerDropdown = null;
    if (this._sceneUpdateHook) {
      Hooks.off("updateScene", this._sceneUpdateHook);
      this._sceneUpdateHook = null;
    }
    if (this._worldTimeHook) {
      Hooks.off("updateWorldTime", this._worldTimeHook);
      this._worldTimeHook = null;
    }
  }

  #setupTypePicker() {
    this.#pickerAbort?.abort();
    this.#pickerAbort = new AbortController();
    const { signal } = this.#pickerAbort;

    this.#pickerDropdown?.remove();
    this.#pickerDropdown = null;

    const trigger  = this.element.querySelector(".location-add-type-trigger");
    const dropdown = trigger?.querySelector(".location-type-picker-dropdown");
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
        const location  = this.#syncSelectedLocation();
        if (!location) return;
        const typeId    = item.dataset.typeId;
        const subTypeId = item.dataset.subTypeId || null;
        const newEntry  = { id: foundry.utils.randomID(), typeId, subTypeId };
        const entries   = getTypeEntries(location);
        entries.push(newEntry);
        location.typeEntries = entries;
        location.typeData ??= {};

        const subType = (this.#getSubTypeMap()[typeId] ?? []).find(s => s.id === subTypeId);
        location.typeData[newEntry.id] = buildEntryTypeData(typeId, subType);

        this._activeTab = newEntry.id;
        dropdown.classList.remove("is-open");
        await this.#saveLocationData(location);
      }, { signal });
    });
  }

  // ------------------------------------------------------------------ helpers

  #getSubTypeMap() {
    const raw = game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES);
    return Array.isArray(raw) ? {} : (raw ?? {});
  }

  #syncSelectedLocation() {
    if (!this._selectedLocationId) return null;
    const locations = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
    return locations.find(r => r.id === this._selectedLocationId) ?? null;
  }

  async #saveLocationData(updatedLocation) {
    const scene = canvas.scene;
    if (!scene) return;
    if (game.user.isGM) {
      const locations = scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
      const index = locations.findIndex(r => r.id === updatedLocation.id);
      if (index === -1) return;
      locations[index] = updatedLocation;
      await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
      this.render({ parts: ["content"] });
    } else {
      // Players lack scene write permission — route through the active GM.
      // The updateScene hook on all clients re-renders this app once the GM saves.
      game.socket.emit(SOCKET_CHANNEL, {
        type: SOCKET_TYPES.SAVE_LOCATION,
        sceneId: scene.id,
        location: updatedLocation
      });
    }
  }

  async #saveEntryData(entryId, data) {
    const location = this.#syncSelectedLocation();
    if (!location) return;
    location.typeData ??= {};
    location.typeData[entryId] = data;
    await this.#saveLocationData(location);
  }

  static async #onEditLocationEntry() {
    if (!game.user.isGM) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const entry = this.#getActiveEntry();
    if (!entry) return;
    const entryData = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? {});
    const result = await SubTypeEditApp.openForEntry(entry.typeId, entryData, { locationName: location.name });
    if (!result) return;
    await this.#saveEntryData(this._activeTab, result);
  }

  // ------------------------------------------------------------------ left pane actions

  static async #onAddLocation() {
    if (!game.user.isGM) return;
    const result = await LocationEditApp.open({});
    if (!result) return;
    const locations = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
    locations.push(result);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    this._selectedLocationId = result.id;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteLocation(event, target) {
    if (!game.user.isGM) return;
    const id = target.closest("[data-location-id]")?.dataset.locationId;
    if (!id) return;
    const locations = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
    const index = locations.findIndex(r => r.id === id);
    if (index === -1) return;
    const location = locations[index];
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.deleteLocationTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.location.deleteLocationConfirm", { name: location.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    locations.splice(index, 1);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    if (this._selectedLocationId === id) this._selectedLocationId = null;
    this.render({ parts: ["content"] });
  }

  static async #onToggleDiscovered(event, target) {
    if (!game.user.isGM) return;
    const id = target.closest("[data-location-id]")?.dataset.locationId;
    if (!id) return;
    const locations = canvas.scene?.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
    const location = locations.find(r => r.id === id);
    if (!location) return;
    location.discovered.default = !location.discovered.default;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    const icon = target.querySelector("i");
    if (icon) icon.className = location.discovered.default ? "fa-solid fa-eye" : "fa-regular fa-eye-slash";
    target.classList.toggle("is-discovered", location.discovered.default);
  }

  static #onSelectLocation(event, target) {
    const id = target.closest("[data-location-id]")?.dataset.locationId;
    if (!id || id === this._selectedLocationId) return;
    this._selectedLocationId = id;
    this._activeTab    = null;
    this._sellTabActive = false;
    this._sellActorId   = null;
    this._showLedger    = false;
    this.render({ parts: ["content"] });
  }

  static #onSwitchTab(event, target) {
    this._activeTab     = target.dataset.tabId;
    this._sellTabActive = false;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteTypeEntry(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.entryId;
    const location = this.#syncSelectedLocation();
    if (!location) return;
    const entries = getTypeEntries(location);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;
    const coreType = CORE_LOCATION_TYPES.find(t => t.id === entry.typeId);
    const subType = entry.subTypeId
      ? (this.#getSubTypeMap()[entry.typeId] ?? []).find(s => s.id === entry.subTypeId)
      : null;
    const typeName = subType?.name ?? coreType?.name ?? entry.typeId;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.removeTypeTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.location.removeTypeConfirm", { type: typeName, location: location.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    location.typeEntries = entries.filter(e => e.id !== entryId);
    if (location.typeData?.[entryId]) delete location.typeData[entryId];
    if (this._activeTab === entryId) this._activeTab = null;
    await this.#saveLocationData(location);
  }

  // ------------------------------------------------------------------ right pane actions

  static async #onRemoveTypeEntry(event, target) {
    if (!game.user.isGM) return;
    const index = parseInt(target.dataset.entryIndex);
    const location = this.#syncSelectedLocation();
    if (!location) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.removeEntryTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.location.removeEntryConfirm", { name: location.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    const entries = getTypeEntries(location);
    entries.splice(index, 1);
    location.typeEntries = entries;
    await this.#saveLocationData(location);
  }

  static async #onEditLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const innData  = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    const index    = innData.lodgings.findIndex(l => l.id === lodgingId);
    if (index === -1) return;
    const lodging = innData.lodgings[index];
    const activeEntry = this.#getActiveEntry();
    const template = lodging.templateItemId ? this.#getTemplateForEntry(activeEntry) : null;
    const templateLodging = template
      ? (template.typeData?.lodgings ?? []).find(l => l.id === lodging.templateItemId) ?? null
      : null;
    const result = await LodgingEditApp.open(lodging, templateLodging);
    if (!result) return;
    innData.lodgings[index] = result;
    await this.#saveEntryData(this._activeTab, innData);
  }

  static async #onDeleteLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const innData = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
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
    const location = this.#syncSelectedLocation();
    const lodging  = location?.typeData?.[this._activeTab]?.lodgings?.find(l => l.id === lodgingId);
    if (!lodging) return;
    cartManager.addLodging({
      sceneId: canvas.scene?.id,
      locationId: location.id,
      locationName: location.name,
      entryId: this._activeTab,
      lodging
    });
    CartApp.open();
  }

  static async #onDismissLedgerEntry(event, target) {
    if (!game.user.isGM) return;
    const ledgerId = target.dataset.entryId;
    if (!ledgerId) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const innData = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    const ledgerEntry = innData.ledger.find(e => e.id === ledgerId);
    if (!ledgerEntry) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.dismissEntryTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.inn.dismissEntryConfirm", { actor: ledgerEntry.actorName ?? "?", lodging: ledgerEntry.lodgingName ?? "?" })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.dismissEntryTitle"), icon: "fa-solid fa-times" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    // Cancelling a booking that hasn't already been reclaimed (e.g. an active stay ended early)
    // frees its room back up; expired/reclaimed bookings were already restored at expiry.
    if (!ledgerEntry.reclaimed) restoreLodgingAvailability(innData, ledgerEntry);
    innData.ledger = innData.ledger.filter(e => e.id !== ledgerId);
    await this.#saveEntryData(this._activeTab, innData);
  }

  static async #onEditBooking(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.entryId;
    if (!entryId) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const innData = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
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
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const innData = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
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

  static async #onRestoreFromTemplate() {
    if (!game.user.isGM) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const entryId  = this._activeTab;
    const template = this.#getTemplateForEntry(this.#getActiveEntry());
    if (!template) return;
    const innData = foundry.utils.deepClone(location.typeData?.[entryId] ?? { lodgings: [], ledger: [] });
    await TemplateRestoreDialog.open(innData, template, async (updatedInn) => {
      await this.#saveEntryData(entryId, updatedInn);
    });
  }

  static async #onRestoreFromMerchantTemplate() {
    if (!game.user.isGM) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const entryId  = this._activeTab;
    const template = this.#getTemplateForEntry(this.#getActiveEntry());
    if (!template) return;
    const merchantData = foundry.utils.deepClone(location.typeData?.[entryId] ?? { inventory: [] });
    await MerchantRestoreDialog.open(merchantData, template, async (updated) => {
      await this.#saveEntryData(entryId, updated);
    });
  }

  static async #onForceRestockMerchant() {
    if (!game.user.isGM) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const merchant = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? { inventory: [] });
    const currencies = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG).currencies ?? [];
    await rollMerchantRestock(merchant.inventory ?? [], merchant.stockType ?? "percent");
    applyPriceVariation(merchant.inventory ?? [], readPriceVarConfig(merchant), currencies);
    rollMerchantBuyRates(merchant.purchasingProfile ?? []);
    merchant.lastRestocked = game.time.worldTime;
    merchant.buybackItems  = [];
    await this.#saveEntryData(this._activeTab, merchant);
    ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.restocked"));
  }

  static async #onRefreshCourse(event, target) {
    if (!game.user.isGM) return;
    const courseId = target.dataset.courseId;
    if (!courseId || !this._activeTab) return;
    const location = this.#syncSelectedLocation();
    if (!location) return;
    const innData = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
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
    const location = this.#syncSelectedLocation();
    const inn = location?.typeData?.[this._activeTab];
    if (!inn) return;
    const course = (inn.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course) return;
    const allItems = course.mode === "random" ? (course.drawnItems ?? []) : (course.items ?? []);
    const item = allItems.find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMenuItem({
      sceneId: canvas.scene?.id,
      locationId: location.id,
      locationName: location.name,
      course,
      item
    });
    CartApp.open();
  }

  static async #onAddMerchantItem(event, target) {
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const location = this.#syncSelectedLocation();
    const item = (location?.typeData?.[this._activeTab]?.inventory ?? []).find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMerchantItem({
      sceneId: canvas.scene?.id,
      locationId: location.id,
      locationName: location.name,
      entryId: this._activeTab,
      item
    });
    CartApp.open();
  }

  static async #onDeleteMerchantItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    if (!itemId || !this._activeTab) return;
    const location = this.#syncSelectedLocation();
    if (!location) return;
    const merchant = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? { inventory: [] });
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
    if (!this._activeTab) return;
    const location = this.#syncSelectedLocation();
    const merchant = foundry.utils.deepClone(location?.typeData?.[this._activeTab] ?? { inventory: [] });
    const existing = merchant.inventory.find(i => i.id === itemId);
    if (!existing) return;
    const result = await MerchantItemEditApp.open(existing);
    if (!result) return;
    const idx = merchant.inventory.findIndex(i => i.id === itemId);
    if (idx !== -1) merchant.inventory[idx] = result;
    await this.#saveEntryData(this._activeTab, merchant);
  }

  static #onSwitchToSellTab() {
    this._sellTabActive = true;
    this.render({ parts: ["content"] });
  }

  static async #onAddToSellCart(event, target) {
    const actorItemId = target.dataset.actorItemId;
    if (!actorItemId) return;
    const actor = this._sellActorId ? game.actors.get(this._sellActorId) : null;
    if (!actor) return;
    const actorItem = actor.items.get(actorItemId);
    if (!actorItem) return;
    const location = this.#syncSelectedLocation();
    if (!location) return;

    const currencies       = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const effectiveProfile = mergePurchasingProfiles(location);
    const rule = findEffectiveRule(effectiveProfile, actorItem.type ?? "");
    if (!rule) return;
    const salePrice = computeSalePrice(actorItem, rule, currencies);
    if (!salePrice) return;

    const qtyInput = this.element.querySelector(`.ssm-sell-qty[data-actor-item-id="${actorItemId}"]`);
    const qty = Math.max(1, parseInt(qtyInput?.value) || 1);

    cartManager.addSellItem({
      sceneId:        canvas.scene?.id,
      locationId:     location.id,
      locationName:   location.name,
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
    if (!buybackId) return;
    const location = this.#syncSelectedLocation();
    if (!location) return;
    const merchantEntries = getTypeEntries(location).filter(e => e.typeId === LOCATION_TYPE_IDS.MERCHANT);
    let buybackEntry = null;
    let buybackEntryId = null;
    for (const me of merchantEntries) {
      const found = (location.typeData?.[me.id]?.buybackItems ?? []).find(b => b.id === buybackId);
      if (found) { buybackEntry = found; buybackEntryId = me.id; break; }
    }
    if (!buybackEntry || !buybackEntry.buybackPrice) return;
    cartManager.addMerchantItem({
      sceneId:      canvas.scene?.id,
      locationId:   location.id,
      locationName: location.name,
      entryId:      buybackEntryId,
      item: {
        id:     buybackEntry.id,
        name:   buybackEntry.itemName,
        itemId: buybackEntry.itemLinkedUuid,
        price:  buybackEntry.buybackPrice
      }
    });
    CartApp.open();
  }

  static async #onAddExchangeToCart(event, target) {
    if (!this._bankActorId) return;
    const section = this.element.querySelector('.ssm-bank-exchange');
    if (!section) return;
    const fromAmount     = parseInt(section.querySelector('[data-field="fromAmount"]')?.value) || 0;
    const fromCurrencyId = section.querySelector('[data-field="fromCurrency"]')?.value ?? "";
    const toCurrencyId   = section.querySelector('[data-field="toCurrency"]')?.value ?? "";
    if (!fromAmount || !fromCurrencyId || !toCurrencyId || fromCurrencyId === toCurrencyId) return;

    const location = this.#syncSelectedLocation();
    if (!location) return;
    const currencies   = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const bankData     = location.typeData?.[this._activeTab] ?? {};
    const actor        = game.actors.get(this._bankActorId);
    if (!actor) return;

    cartManager.addExchange({
      sceneId:        canvas.scene?.id,
      locationId:     location.id,
      locationName:   location.name,
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

    const currencyConfig  = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies      = currencyConfig.currencies ?? [];
    const location        = this.#syncSelectedLocation();
    if (!location) return;
    const bankRaw         = location.typeData?.[this._activeTab] ?? {};
    const depositSettings = bankRaw.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 };
    const feeRate         = depositSettings.depositFee ?? 0;

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
      locationId: location.id,
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
    this.render({ parts: ["content"] });
  }

  static async #onResetBankSettings() {
    if (!game.user.isGM) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
    const bankData    = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? {});
    const activeEntry = this.#getActiveEntry();
    const subType     = activeEntry?.subTypeId
      ? (this.#getSubTypeMap()[LOCATION_TYPE_IDS.BANK] ?? []).find(s => s.id === activeEntry.subTypeId)
      : null;
    restoreFields(bankData, subType?.typeData?.bank ?? {}, TEMPLATE_FIELDS.bank);
    await this.#saveEntryData(this._activeTab, bankData);
  }

  // --- Loans -------------------------------------------------------------------------------

  static async #onCreateLoanOffer() {
    if (!game.user.isGM) return;
    const location = this.#syncSelectedLocation();
    if (!location || !this._activeTab) return;
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

    const bank = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? {});
    bank.loans = [...(bank.loans ?? []), loan];
    this._bankActorId = result.actorId; // surface the new offer immediately
    await this.#saveEntryData(this._activeTab, bank);
    ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.offerCreated"));
  }

  static async #onAcceptLoan(event, target) {
    const loanId = target.dataset.loanId;
    if (!loanId) return;
    const location = this.#syncSelectedLocation();
    const loan = (location?.typeData?.[this._activeTab]?.loans ?? []).find(l => l.id === loanId);
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

    const payload = { loanId, locationId: location.id, entryId: this._activeTab, sceneId: canvas.scene?.id, userId: game.user.id };
    if (game.user.isGM) await _handleAcceptLoan(payload);
    else game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.ACCEPT_LOAN, payload });
    this.render({ parts: ["content"] });
  }

  static async #onDeclineLoan(event, target) {
    const loanId = target.dataset.loanId;
    if (!loanId) return;
    const location = this.#syncSelectedLocation();
    if (!location) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      title:   game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.declineConfirmTitle"),
      content: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.loans.declineConfirmBody")
    });
    if (!confirmed) return;

    const payload = { loanId, locationId: location.id, entryId: this._activeTab, sceneId: canvas.scene?.id, userId: game.user.id };
    if (game.user.isGM) await _handleDeclineLoan(payload);
    else game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.DECLINE_LOAN, payload });
    this.render({ parts: ["content"] });
  }

  static async #onRepayLoan(event, target) {
    const loanId = target.dataset.loanId;
    const location = this.#syncSelectedLocation();
    const loan = (location?.typeData?.[this._activeTab]?.loans ?? []).find(l => l.id === loanId);
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
    await this.#submitRepayment(loan, location, payCoins, currencies, mode);
  }

  static async #onPayOffLoan(event, target) {
    const loanId = target.dataset.loanId;
    const location = this.#syncSelectedLocation();
    const loan = (location?.typeData?.[this._activeTab]?.loans ?? []).find(l => l.id === loanId);
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
    await this.#submitRepayment(loan, location, coins, currencies, mode);
  }

  /** Shared by repay (from inputs) and pay-off-in-full: verify funds, confirm (with any change), debit, dispatch. */
  async #submitRepayment(loan, location, payCoins, currencies, mode) {
    const filtered = {};
    for (const [cId, amt] of Object.entries(payCoins ?? {})) {
      const n = Math.max(0, Math.floor(amt));
      if (n > 0) filtered[cId] = n;
    }
    if (!Object.keys(filtered).length || !location) return;
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

    const payload = { loanId: loan.id, payCoins: filtered, locationId: location.id, entryId: this._activeTab, sceneId: canvas.scene?.id, userId: game.user.id };
    if (game.user.isGM) await _handleRepayLoan(payload);
    else game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.REPAY_LOAN, payload });
    this.render({ parts: ["content"] });
  }

  static async #onCancelLoan(event, target) {
    if (!game.user.isGM) return;
    const loanId = target.dataset.loanId;
    const location = this.#syncSelectedLocation();
    if (!location) return;
    const bank = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? {});
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
    const location = this.#syncSelectedLocation();
    if (!location) return;
    const bank = foundry.utils.deepClone(location.typeData?.[this._activeTab] ?? {});
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
        this.render({ parts: ["content"] });
      });
    }
    const bankFilterBtn = this.element.querySelector('.ssm-actor-filter-btn[data-actor-context="bank"]');
    if (bankFilterBtn) {
      this.#wireActorFilterMenu(bankFilterBtn, this._bankActorFilter, signal, f => {
        this._bankActorFilter = f;
        this.render({ parts: ["content"] });
      });
    }

    const sellWidget = this.element.querySelector('.ssm-actor-dropdown-widget[data-actor-context="sell"]');
    if (sellWidget) {
      this.#wireActorDropdown(sellWidget, signal, id => {
        this._sellActorId = id;
        this.render({ parts: ["content"] });
      });
    }
    const sellFilterBtn = this.element.querySelector('.ssm-actor-filter-btn[data-actor-context="sell"]');
    if (sellFilterBtn) {
      this.#wireActorFilterMenu(sellFilterBtn, this._sellActorFilter, signal, f => {
        this._sellActorFilter = f;
        this.render({ parts: ["content"] });
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

  static async #onWithdrawDeposit(event, target) {
    if (!this._bankActorId) return;
    const actor = game.actors.get(this._bankActorId);
    if (!actor) return;

    let depositIds;
    try { depositIds = JSON.parse(target.dataset.depositIds); } catch { return; }
    if (!depositIds?.length) return;

    const currencyConfig  = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies      = currencyConfig.currencies ?? [];
    const location        = this.#syncSelectedLocation();
    if (!location) return;
    const bankRaw         = location.typeData?.[this._activeTab] ?? {};
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
      locationId:     location.id,
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

    this.render({ parts: ["content"] });
  }

  static async #onEditDeposit(event, target) {
    if (!game.user.isGM) return;

    let depositIds;
    try { depositIds = JSON.parse(target.dataset.depositIds); } catch { return; }
    if (!depositIds?.length) return;

    const currencyConfig  = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies      = currencyConfig.currencies ?? [];
    const location        = this.#syncSelectedLocation();
    if (!location) return;
    const bankRaw         = location.typeData?.[this._activeTab] ?? {};
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
      locationId:     location.id,
      entryId:        this._activeTab,
      sceneId:        canvas.scene?.id,
      isGlobal
    });

    this.render({ parts: ["content"] });
  }

  // ------------------------------------------------------------------ ledger actions

  static #onSettlementLedger() {
    this._showLedger = true;
    this._selectedLocationId = null;
    this.render({ parts: ["content"] });
  }

  static async #onClearLedger() {
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.LEDGER, []);
    this.render({ parts: ["content"] });
  }

  static #onExportLedgerCsv() {
    const rawLedger = canvas.scene?.getFlag(MODULE_ID, FLAGS.LEDGER) ?? [];
    const currencies = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const { hoursPerDay } = getWorldTimeConfig();
    const secondsPerDay = hoursPerDay * 3600;
    const header = 'Day,Location,Actor,Type,Item,Qty,Amount,Currency\n';
    const rows = rawLedger.map(e => {
      const curr = currencies.find(c => c.id === e.currencyId);
      const day = Math.floor(e.timestamp / secondsPerDay) + 1;
      const qty = e.quantityUnit ? `${e.quantity} ${e.quantityUnit}` : e.quantity;
      return [day, e.locationName, e.actorName, e.transactionType, e.itemName, qty, e.amount, curr?.abbreviation ?? e.currencyId]
        .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',');
    });
    const csv = header + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'settlement-ledger.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}
