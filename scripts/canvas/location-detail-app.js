import { MODULE_ID, FLAGS, SETTINGS, LOCATION_TYPE_IDS, CORE_LOCATION_TYPES, getTypeEntries } from "../constants.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { cartManager } from "./cart-manager.js";
import { CartApp } from "./cart-app.js";
import { MenuConfigApp } from "./inn/menu-config-app.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { readItemName, readItemPrice, readItemAttributes } from "../utils/item-utils.js";
import { costInStandard, calculateChange, formatAmounts, getSettlementMaxDenomValue, parseExchangeRate, totalOfferedInStandard, removeCoinsFromActor } from "../utils/currency-utils.js";
import { WithdrawalDialog } from "./withdrawal-dialog.js";
import { SOCKET_CHANNEL, SOCKET_TYPES, _handleRecordDeposit, _handleProcessWithdrawal } from "../socket.js";
import { MerchantItemEditApp } from "./merchant-item-edit-app.js";
import { mergePurchasingProfiles, findEffectiveRule, computeSalePrice, computeBuybackPrice } from "./purchasing-utils.js";
import { isOverridden, restoreFields, TEMPLATE_FIELDS } from "./template-link.js";
import { PurchasingProfileEditApp } from "./purchasing-profile-edit-app.js";
import { MerchantRestoreDialog } from "./merchant-restore-dialog.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

function buildDepositDisplayList(deposits, now, secondsPerDay, currencies) {
  const matured   = deposits.filter(d => now >= d.depositedAt + d.minDepositSeconds);
  const unmatured = deposits.filter(d => now <  d.depositedAt + d.minDepositSeconds);
  const result = [];
  if (matured.length > 0) {
    const mergedCoins = {};
    for (const d of matured) for (const [cId, amt] of Object.entries(d.coins)) mergedCoins[cId] = (mergedCoins[cId] ?? 0) + amt;
    result.push({
      id:                matured[0].id,
      idsJson:           JSON.stringify(matured.map(d => d.id)),
      coins:             mergedCoins,
      coinsLabel:        formatAmounts(mergedCoins, currencies),
      matured:           true,
      timeRemainingLabel: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.matured"),
      depositedAt:       matured[0].depositedAt,
      minDepositSeconds: 0
    });
  }
  const sortedUnmatured = [...unmatured].sort((a, b) => (a.depositedAt + a.minDepositSeconds) - (b.depositedAt + b.minDepositSeconds));
  for (const dep of sortedUnmatured) {
    const remainingDays = Math.ceil((dep.depositedAt + dep.minDepositSeconds - now) / secondsPerDay);
    result.push({
      id:                dep.id,
      idsJson:           JSON.stringify([dep.id]),
      coins:             dep.coins,
      coinsLabel:        formatAmounts(dep.coins, currencies),
      matured:           false,
      timeRemainingLabel: game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.daysRemaining", { days: remainingDays }),
      depositedAt:       dep.depositedAt,
      minDepositSeconds: dep.minDepositSeconds
    });
  }
  return result;
}

export class LocationDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _location;
  _activeTab = null;
  _sellTabActive = false;
  _sellActorId   = null;
  _bankActorId   = null;
  _sceneUpdateHook = null;
  _worldTimeHook   = null;

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
      addLodging:         LocationDetailApp.#onAddLodging,
      editLodging:        LocationDetailApp.#onEditLodging,
      deleteLodging:      LocationDetailApp.#onDeleteLodging,
      rentLodging:        LocationDetailApp.#onRentLodging,
      dismissLedgerEntry: LocationDetailApp.#onDismissLedgerEntry,
      configureMenu:      LocationDetailApp.#onConfigureMenu,
      refreshCourse:      LocationDetailApp.#onRefreshCourse,
      buyMenuItem:        LocationDetailApp.#onBuyMenuItem,
      buyInventoryItem:         LocationDetailApp.#onBuyInventoryItem,
      deleteMerchantItem:       LocationDetailApp.#onDeleteMerchantItem,
      editMerchantItem:         LocationDetailApp.#onEditMerchantItem,
      addManualInventoryItem:         LocationDetailApp.#onAddManualInventoryItem,
      restoreFromMerchantTemplate:    LocationDetailApp.#onRestoreFromMerchantTemplate,
      switchToSellTab:                LocationDetailApp.#onSwitchToSellTab,
      switchFromSellTab:        LocationDetailApp.#onSwitchFromSellTab,
      selectSellActor:          LocationDetailApp.#onSelectSellActor,
      addToSellCart:            LocationDetailApp.#onAddToSellCart,
      buyBackItem:              LocationDetailApp.#onBuyBackItem,
      editPurchasingProfile:    LocationDetailApp.#onEditPurchasingProfile,
      addExchangeToCart:        LocationDetailApp.#onAddExchangeToCart,
      depositCoins:             LocationDetailApp.#onDepositCoins,
      withdrawDeposit:          LocationDetailApp.#onWithdrawDeposit,
      overrideBankSettings:     LocationDetailApp.#onOverrideBankSettings,
      resetBankSettings:        LocationDetailApp.#onResetBankSettings
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
      this._worldTimeHook = Hooks.on("updateWorldTime", () => this.render());
    }

    // Wire sell actor select
    const sellActorSelect = this.element.querySelector('.ssm-sell-actor-select');
    if (sellActorSelect) {
      sellActorSelect.addEventListener('change', () => {
        this._sellActorId = sellActorSelect.value || null;
        this.render();
      });
    }

    // Wire bank actor select
    const bankActorSelect = this.element.querySelector('.ssm-bank-actor-select');
    if (bankActorSelect) {
      bankActorSelect.addEventListener('change', () => {
        this._bankActorId = bankActorSelect.value || null;
        this.render();
      });
    }

    // Wire bank exchange live preview
    const exchangeSection = this.element.querySelector('.ssm-bank-exchange');
    if (exchangeSection) this.#wireExchangePreview(exchangeSection);

    // Wire merchant drop zone (GM only)
    if (game.user.isGM) {
      const dropZone = this.element.querySelector(".merchant-drop-zone");
      if (dropZone) {
        dropZone.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; dropZone.classList.add("drag-over"); });
        dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
        dropZone.addEventListener("drop",      e => { dropZone.classList.remove("drag-over"); this.#onMerchantDrop(e); });
      }
    }
  }

  async _onClose(options) {
    await super._onClose(options);
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

      const innData = isInn ? this.#buildInnData(entry, currencies, isGM) : null;
      let merchantData = null;
      if (isMerchant) {
        const merchantResult = await this.#buildMerchantData(entry, currencies, isGM);
        if (merchantResult._needsSave && isGM) this.#saveEntryData(entry.id, merchantResult._updatedMerchant).catch(() => {});
        if (isGM) merchantResult.canRestore = !!this.#getTemplateForEntry(entry);
        merchantData = merchantResult;
      }
      const bankData = isBank ? this.#buildBankData(entry, currencies) : null;

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
      sellData = await this.#buildSellData(currencies, isGM, effectiveProfile);
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

  #buildInnData(entry, currencies, isGM) {
    const innRaw = this._location.typeData?.[entry.id] ?? { lodgings: [], ledger: [] };
    const { daysPerWeek, hoursPerDay } = getWorldTimeConfig();
    const worldTime = game.time.worldTime;

    const lodgings = (innRaw.lodgings ?? []).map(l => {
      const dayCurr = currencies.find(c => c.id === l.pricePerDay?.currencyId);
      const dayLabel = `${l.pricePerDay?.amount ?? 0} ${dayCurr?.abbreviation ?? "?"}`;
      const weeklyAmount = l.pricePerWeek?.amount ?? ((l.pricePerDay?.amount ?? 0) * daysPerWeek);
      const weekCurr = l.pricePerWeek ? currencies.find(c => c.id === l.pricePerWeek.currencyId) : dayCurr;
      const weekLabel = `${weeklyAmount} ${weekCurr?.abbreviation ?? "?"}`;
      const avail     = l.availability ?? null;
      return {
        ...l,
        overridden:          isOverridden(l, TEMPLATE_FIELDS.lodging),
        pricePerDayLabel:    dayLabel,
        pricePerWeekLabel:   weekLabel,
        availabilityDisplay: avail === null ? "∞" : String(avail),
        isSoldOut:           typeof avail === "number" && avail <= 0
      };
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

    const menuData = this.#buildMenuData(innRaw, currencies, isGM, daysPerWeek, hoursPerDay, worldTime);
    if (menuData._needsSave && isGM) {
      const updatedInn = foundry.utils.deepClone(innRaw);
      updatedInn.menu = menuData._updatedMenu;
      this.#saveEntryData(entry.id, updatedInn).catch(() => {});
    }

    return { lodgings, ledger, isGM, menuData };
  }

  #buildMenuData(innRaw, currencies, isGM, daysPerWeek, hoursPerDay, worldTime) {
    const rawMenu = innRaw.menu ?? { courses: [] };
    const secondsPerDay  = (hoursPerDay ?? 24) * 3600;
    const secondsPerWeek = secondsPerDay * (daysPerWeek ?? 7);

    let _needsSave = false;
    const updatedCourses = foundry.utils.deepClone(rawMenu.courses ?? []);

    const courses = updatedCourses.map(course => {
      const isRandom = course.mode === "random";

      if (isRandom && isGM) {
        const cadenceSecs = course.refreshCadence === "weekly" ? secondsPerWeek : secondsPerDay;
        const due = (course.lastRefreshed ?? 0) + cadenceSecs;
        if (worldTime >= due && (course.pool ?? []).length > 0) {
          const shuffled = [...(course.pool ?? [])].sort(() => Math.random() - 0.5);
          course.drawnItems    = shuffled.slice(0, course.drawCount ?? 3);
          course.lastRefreshed = worldTime;
          _needsSave = true;
        }
      }

      const visibleItems = isRandom ? (course.drawnItems ?? []) : (course.items ?? []);
      let priceLabel = null;
      if (course.price) {
        const curr = currencies.find(c => c.id === course.price.currencyId);
        priceLabel = `${course.price.amount} ${curr?.abbreviation ?? "?"}`;
      }
      return {
        ...course,
        overridden: isOverridden(course, TEMPLATE_FIELDS.course),
        isRandom,
        priceLabel,
        visibleItems: visibleItems.map(item => {
          const resolvedPrice = item.price ?? course.price;
          let priceLabel = null;
          if (resolvedPrice) {
            const curr = currencies.find(c => c.id === resolvedPrice.currencyId);
            priceLabel = `${resolvedPrice.amount} ${curr?.abbreviation ?? "?"}`;
          }
          return { ...item, priceLabel, hasPrice: !!resolvedPrice };
        })
      };
    });

    return {
      courses,
      hasCourses: courses.length > 0,
      _needsSave,
      _updatedMenu: { courses: updatedCourses }
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

  async #buildMerchantData(entry, currencies, isGM) {
    const merchant       = this._location.typeData?.[entry.id] ?? {};
    const rawInventory   = merchant.inventory ?? [];
    const stockType        = merchant.stockType        ?? "percent";
    const restockFrequency = merchant.restockFrequency ?? "weekly";

    const itemConfig  = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);
    const typeConfigs = itemConfig.itemTypes ?? [];
    const typeMap     = Object.fromEntries(typeConfigs.map(t => [t.systemType, t]));

    const settlementTypes      = game.settings.get(MODULE_ID, SETTINGS.SETTLEMENT_TYPES) ?? [];
    const currentSettlementType = canvas.scene?.getFlag(MODULE_ID, FLAGS.SETTLEMENT_TYPE) ?? "";
    const currentSettlementIdx  = settlementTypes.findIndex(t => t.name === currentSettlementType);

    const { hoursPerDay, daysPerWeek } = getWorldTimeConfig();
    const spd         = hoursPerDay * 3600;
    const cadenceSecs = { daily: spd, weekly: spd * daysPerWeek, monthly: spd * daysPerWeek * 4 }[restockFrequency] ?? spd;
    const restockDue  = isGM && (merchant.lastRestocked == null || game.time.worldTime >= merchant.lastRestocked + cadenceSecs);

    let _needsSave = false;
    const workingInventory = foundry.utils.deepClone(rawInventory);

    if (restockDue) {
      for (const item of workingInventory) {
        if (!(item.stockFormula ?? "").trim()) continue;
        let avail;
        if (stockType === "x-in-6") {
          const roll = await new Roll("1d6").evaluate();
          avail = roll.total <= (item.stockAvailability ?? 6);
        } else {
          avail = Math.random() * 100 < (item.stockAvailability ?? 100);
        }
        item.quantity = avail
          ? Math.floor((await new Roll(String(item.stockFormula)).evaluate()).total)
          : 0;
      }
      _needsSave = true;
    }

    const displayInventory = workingInventory.filter(item => {
      const min = item.minSettlementSize ?? "";
      if (!min) return true;
      const minIdx = settlementTypes.findIndex(t => t.name === min);
      return minIdx === -1 || currentSettlementIdx >= minIdx;
    });

    const groupMap = new Map();

    for (const item of displayInventory) {
      const typeKey = item.itemType ?? null;
      const typeCfg = typeKey ? (typeMap[typeKey] ?? null) : null;
      const groupKey = typeCfg ? typeKey : null;

      let priceLabel = "—";
      if (item.price) {
        const curr = currencies.find(c => c.id === item.price.currencyId);
        priceLabel = `${item.price.amount} ${curr?.abbreviation ?? "?"}`;
      }

      let attrValues = {};
      if (item.itemId && typeCfg?.attributes?.length) {
        const fi = await fromUuid(item.itemId).catch(() => null);
        if (fi) attrValues = readItemAttributes(fi, typeCfg);
      }

      const attrCells = (typeCfg?.attributes ?? []).map(a => ({
        id: a.id, label: a.label, value: attrValues[a.id] ?? "—"
      }));

      const hasFormula = !!(item.stockFormula ?? "").trim();
      const isSoldOut  = hasFormula && item.quantity === 0;
      const stockLabel = hasFormula
        ? (item.quantity == null ? "∞" : String(item.quantity))
        : "∞";

      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          typeKey: groupKey,
          label:      typeCfg?.label ?? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.otherGroup"),
          attributes: typeCfg?.attributes ?? [],
          items:      []
        });
      }
      groupMap.get(groupKey).items.push({ ...item, priceLabel, attrCells, stockLabel, isSoldOut });
    }

    const groups = [
      ...typeConfigs.filter(t => groupMap.has(t.systemType)).map(t => groupMap.get(t.systemType)),
      ...(groupMap.has(null) ? [groupMap.get(null)] : [])
    ];

    const flatInventory = displayInventory.map(item => {
      let priceLabel = "—";
      if (item.price) {
        const curr = currencies.find(c => c.id === item.price.currencyId);
        priceLabel = `${item.price.amount} ${curr?.abbreviation ?? "?"}`;
      }
      const hasFormula = !!(item.stockFormula ?? "").trim();
      const isSoldOut  = hasFormula && item.quantity === 0;
      const stockLabel = hasFormula
        ? (item.quantity == null ? "∞" : String(item.quantity))
        : "∞";
      return { ...item, priceLabel, attrCells: [], stockLabel, isSoldOut };
    });

    const updatedMerchant = { ...merchant, inventory: workingInventory, lastRestocked: game.time.worldTime };
    if (_needsSave) updatedMerchant.buybackItems = []; // clear buyback cache on restock

    return {
      groups, flatInventory, isGM, hasGroups: typeConfigs.length > 0,
      _needsSave,
      _updatedMerchant: updatedMerchant
    };
  }

  async #buildSellData(currencies, isGM, effectiveProfile) {
    const hasConflicts = effectiveProfile.some(r => r._conflicted || r._buybackConflicted);

    const ownedActors = game.actors.filter(a => a.testUserPermission(game.user, "OWNER"));
    const defaultActor = (this._sellActorId ? game.actors.get(this._sellActorId) : null)
      ?? game.user.character
      ?? ownedActors[0]
      ?? null;
    if (defaultActor && !this._sellActorId) this._sellActorId = defaultActor.id;

    const actorOptions = ownedActors.map(a => ({
      id: a.id, name: a.name, selected: a.id === defaultActor?.id
    }));

    const itemConfig  = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);
    const typeConfigs = itemConfig.itemTypes ?? [];

    const settlementMaxDenomValue = getSettlementMaxDenomValue(currencies);

    const sellableItems = [];
    if (defaultActor) {
      for (const actorItem of defaultActor.items) {
        const rule = findEffectiveRule(effectiveProfile, actorItem.type ?? "");
        if (!rule || rule.buyRate === null) continue;
        const salePrice = computeSalePrice(actorItem, rule, currencies);
        if (!salePrice) continue;
        const curr = currencies.find(c => c.id === salePrice.currencyId);
        const typeCfg  = typeConfigs.find(t => t.systemType === actorItem.type) ?? null;
        const saleStd  = costInStandard(salePrice, currencies);
        const breakdown = calculateChange(saleStd, currencies, settlementMaxDenomValue);
        const salePriceLabel = (breakdown && Object.values(breakdown).some(v => v > 0))
          ? formatAmounts(breakdown, currencies)
          : `${salePrice.amount} ${curr?.abbreviation ?? "?"}`;
        sellableItems.push({
          actorItemId:   actorItem.id,
          name:          actorItem.name,
          typeLabel:     typeCfg?.label ?? (actorItem.type ?? ""),
          itemLinkedUuid: actorItem.uuid,
          salePrice,
          salePriceLabel
        });
      }
    }

    const merchantEntries = getTypeEntries(this._location).filter(e => e.typeId === LOCATION_TYPE_IDS.MERCHANT);
    const rawBuyback = merchantEntries.flatMap(me =>
      (this._location.typeData?.[me.id]?.buybackItems ?? []).map(b => ({ ...b, _entryId: me.id }))
    );
    const buybackItems = rawBuyback.map(entry => {
      const curr = currencies.find(c => c.id === entry.buybackPrice?.currencyId);
      return {
        ...entry,
        buybackPriceLabel: entry.buybackPrice
          ? `${entry.buybackPrice.amount} ${curr?.abbreviation ?? "?"}`
          : "—"
      };
    });

    return { effectiveProfile, hasConflicts, actors: actorOptions, selectedActorId: defaultActor?.id ?? null, sellableItems, buybackItems };
  }

  #buildBankData(entry, currencies) {
    const bankRaw    = this._location.typeData?.[entry.id] ?? {};
    const ownedActors = game.actors
      .filter(a => a.isOwner && a.hasPlayerOwner)
      .map(a => ({ id: a.id, name: a.name }));
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const mode = currencyConfig.mode ?? 'loose';
    const actor = this._bankActorId ? game.actors.get(this._bankActorId) : null;
    const balances = actor ? currencies.map(c => {
      let amount = 0;
      if (mode === 'attribute' && c.attributePath)
        amount = foundry.utils.getProperty(actor, c.attributePath) ?? 0;
      else if (mode === 'item' && c.itemName) {
        const item = actor.items.find(i => i.name === c.itemName);
        amount = item ? (foundry.utils.getProperty(item, 'system.quantity') ?? 0) : 0;
      }
      return { id: c.id, abbreviation: c.abbreviation, amount };
    }) : [];
    const lowestCurrency   = currencies.length ? currencies.reduce((min, c) => parseExchangeRate(c.exchangeRate) < parseExchangeRate(min.exchangeRate) ? c : min) : null;
    const standardCurrency = currencies.find(c => c.isStandard) ?? null;

    // Resolve effective settings: template when not overridden, stored values when overridden
    const settingsOverridden = isOverridden(bankRaw, TEMPLATE_FIELDS.bank);
    const subType = entry.subTypeId
      ? ((game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES))[LOCATION_TYPE_IDS.BANK] ?? []).find(s => s.id === entry.subTypeId)
      : null;
    const hasTemplate = !!subType;
    const src = (settingsOverridden || !subType) ? bankRaw : (subType.typeData?.bank ?? {});
    const doesExchange    = src.doesExchange ?? false;
    const exchangeFee     = src.exchangeFee  ?? 0;
    const depositSettings = src.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 };

    const rawDeposits = depositSettings.global
      ? (game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [])
      : (bankRaw.deposits ?? []);
    const actorDeposits = this._bankActorId ? rawDeposits.filter(d => d.actorId === this._bankActorId) : [];
    const { hoursPerDay } = getWorldTimeConfig();
    const secondsPerDay   = hoursPerDay * 3600;
    const now             = game.time.worldTime;
    const processedDeposits = buildDepositDisplayList(actorDeposits, now, secondsPerDay, currencies);
    const allCoins = {};
    for (const dep of actorDeposits) {
      for (const [cId, amt] of Object.entries(dep.coins)) {
        allCoins[cId] = (allCoins[cId] ?? 0) + amt;
      }
    }
    const depositsTotal = actorDeposits.length ? formatAmounts(allCoins, currencies) : null;

    return {
      doesExchange,
      exchangeFee,
      currencies:           currencies.map(c => {
        const bal = balances.find(b => b.id === c.id);
        return { id: c.id, name: c.name, abbreviation: c.abbreviation, exchangeRate: c.exchangeRate, balance: bal?.amount ?? 0 };
      }),
      ownedActors,
      selectedActorId:      this._bankActorId ?? null,
      balances,
      defaultFromCurrencyId: lowestCurrency?.id ?? null,
      defaultToCurrencyId:   standardCurrency?.id ?? null,
      depositSettings,
      processedDeposits,
      depositsTotal,
      isOverridden: settingsOverridden,
      hasTemplate,
      isGM: game.user.isGM
    };
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

  async #onMerchantDrop(event) {
    if (!game.user.isGM) return;
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data?.type !== "Item") return;
    const item = await fromUuid(data.uuid).catch(() => null);
    if (!item) return;

    const currencies = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const name  = readItemName(item);
    const price = readItemPrice(item, currencies);

    const merchant = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { inventory: [] });
    merchant.inventory.push({ id: foundry.utils.randomID(), name, price, itemId: item.uuid, quantity: null, itemType: item.type ?? null });
    await this.#saveEntryData(this._activeTab, merchant);
  }

  static #onSwitchTab(event, target) {
    this._activeTab = target.dataset.tabId;
    this.render();
  }

  static async #onAddLodging() {
    if (!game.user.isGM) return;
    const result = await LodgingEditApp.open({});
    if (!result) return;
    result.id ??= foundry.utils.randomID();
    const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    innData.lodgings.push(result);
    await this.#saveEntryData(this._activeTab, innData);
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
    innData.ledger = innData.ledger.filter(e => e.id !== entryId);
    await this.#saveEntryData(this._activeTab, innData);
  }

  static async #onConfigureMenu() {
    if (!game.user.isGM) return;
    const inn      = this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [], menu: { courses: [] } };
    const template = this.#getTemplateForEntry(this.#getActiveEntry());
    await MenuConfigApp.open(
      inn.menu ?? { courses: [] },
      async (updatedMenu) => {
        const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
        innData.menu = updatedMenu;
        await this.#saveEntryData(this._activeTab, innData);
      },
      template
    );
  }

  static async #onRefreshCourse(event, target) {
    if (!game.user.isGM) return;
    const courseId = target.dataset.courseId;
    if (!courseId) return;
    const innData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { lodgings: [], ledger: [] });
    const course = (innData.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course || course.mode !== "random") return;
    const shuffled = [...(course.pool ?? [])].sort(() => Math.random() - 0.5);
    course.drawnItems    = shuffled.slice(0, course.drawCount ?? 3);
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

  static async #onAddManualInventoryItem() {
    if (!game.user.isGM) return;
    const result = await MerchantItemEditApp.open({});
    if (!result) return;
    const merchant = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? { inventory: [] });
    merchant.inventory.push(result);
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

  static async #onEditPurchasingProfile() {
    if (!game.user.isGM) return;
    await PurchasingProfileEditApp.open(this._location);
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
      sceneId:    canvas.scene?.id,
      isGlobal:   depositSettings.global ?? false
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
      sceneId:        canvas.scene?.id,
      isGlobal:       depositSettings.global ?? false
    };

    if (game.user.isGM) {
      await _handleProcessWithdrawal(payload);
    } else {
      game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.PROCESS_WITHDRAWAL, payload });
    }

    this.render();
  }

  static async #onOverrideBankSettings() {
    if (!game.user.isGM) return;
    const bankRaw      = this._location.typeData?.[this._activeTab] ?? {};
    const settingsOverridden = isOverridden(bankRaw, TEMPLATE_FIELDS.bank);
    const activeEntry  = this.#getActiveEntry();
    const subType      = activeEntry?.subTypeId
      ? ((game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES))[LOCATION_TYPE_IDS.BANK] ?? []).find(s => s.id === activeEntry.subTypeId)
      : null;
    const src  = (settingsOverridden || !subType) ? bankRaw : (subType.typeData?.bank ?? {});
    const dSrc = src.depositSettings ?? {};

    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.overrideTitle") },
      content: `
        <div class="form-group">
          <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.doesExchangeLabel")}</label>
          <input type="checkbox" name="doesExchange"${src.doesExchange ? ' checked' : ''}>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.exchangeFeeLabel")}</label>
          <input type="number" name="exchangeFee" value="${src.exchangeFee ?? 0}" min="0" max="100" step="0.1" style="width:6rem">
          <span>%</span>
        </div>
        <hr>
        <div class="form-group">
          <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.globalLabel")}</label>
          <input type="checkbox" name="depositGlobal"${dSrc.global ? ' checked' : ''}>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.depositFeeLabel")}</label>
          <input type="number" name="depositFee" value="${dSrc.depositFee ?? 0}" min="0" max="100" step="0.1" style="width:6rem">
          <span>%</span>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.minDepositDaysLabel")}</label>
          <input type="number" name="minDepositDays" value="${dSrc.minDepositDays ?? 0}" min="0" step="1" style="width:6rem">
          <span>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.daysUnit")}</span>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.deposits.earlyWithdrawalFeeLabel")}</label>
          <input type="number" name="earlyWithdrawalFee" value="${dSrc.earlyWithdrawalFee ?? 0}" min="0" max="100" step="0.1" style="width:6rem">
          <span>%</span>
        </div>
      `,
      ok: {
        label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.overrideSave"),
        callback: (_event, button) => ({
          doesExchange:       button.form.elements.doesExchange.checked,
          exchangeFee:        parseFloat(button.form.elements.exchangeFee.value) || 0,
          depositGlobal:      button.form.elements.depositGlobal.checked,
          depositFee:         parseFloat(button.form.elements.depositFee.value) || 0,
          minDepositDays:     parseInt(button.form.elements.minDepositDays.value) || 0,
          earlyWithdrawalFee: parseFloat(button.form.elements.earlyWithdrawalFee.value) || 0
        })
      },
      rejectClose: false
    });
    if (!result) return;

    const bankData = foundry.utils.deepClone(this._location.typeData?.[this._activeTab] ?? {});
    bankData.doesExchange        = result.doesExchange;
    bankData.exchangeFee         = result.exchangeFee;
    bankData.depositSettings     = {
      global:             result.depositGlobal,
      depositFee:         result.depositFee,
      minDepositDays:     result.minDepositDays,
      earlyWithdrawalFee: result.earlyWithdrawalFee
    };
    await this.#saveEntryData(this._activeTab, bankData);
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
