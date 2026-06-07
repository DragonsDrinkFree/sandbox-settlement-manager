import { MODULE_ID, FLAGS, SETTINGS, RESOURCE_TYPE_IDS, CORE_RESOURCE_TYPES, getTypeEntries } from "../constants.js";
import { ResourceEditApp } from "./resource-edit-app.js";
import { CurrencyTestConfigApp } from "./currency-test-config.js";
import { LodgingEditApp } from "./inn/lodging-edit-app.js";
import { cartManager } from "./cart-manager.js";
import { CartApp } from "./cart-app.js";
import { MenuConfigApp } from "./inn/menu-config-app.js";
import { TemplateRestoreDialog } from "./inn/template-restore-dialog.js";
import { PurchaseDialog } from "./purchase-dialog.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { readItemName, readItemPrice, readItemAttributes } from "../utils/item-utils.js";
import { costInStandard, calculateChange, formatAmounts, getCityMaxDenomValue, parseExchangeRate, totalOfferedInStandard, removeCoinsFromActor } from "../utils/currency-utils.js";
import { MerchantItemEditApp } from "./merchant-item-edit-app.js";
import { SOCKET_CHANNEL, SOCKET_TYPES, _handleRecordDeposit, _handleProcessWithdrawal } from "../socket.js";
import { WithdrawalDialog } from "./withdrawal-dialog.js";
import { mergePurchasingProfiles, findEffectiveRule, computeSalePrice } from "./purchasing-utils.js";
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

export class CityManageApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _selectedResourceId = null;
  _activeTab = null;
  _sellTabActive = false;
  _sellActorId   = null;
  _bankActorId   = null;
  _sceneUpdateHook = null;
  _worldTimeHook   = null;
  #pickerAbort = null;
  #pickerDropdown = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-city-manage`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.manage.title", resizable: true },
    position: { width: 750, height: 560 },
    actions: {
      addResource:        CityManageApp.#onAddResource,
      deleteResource:     CityManageApp.#onDeleteResource,
      toggleDiscovered:   CityManageApp.#onToggleDiscovered,
      configureExpenses:  CityManageApp.#onConfigureExpenses,
      selectResource:     CityManageApp.#onSelectResource,
      switchTab:          CityManageApp.#onSwitchTab,
      deleteTypeEntry:    CityManageApp.#onDeleteTypeEntry,
      removeTypeEntry:    CityManageApp.#onRemoveTypeEntry,
      addLodging:         CityManageApp.#onAddLodging,
      editLodging:        CityManageApp.#onEditLodging,
      deleteLodging:      CityManageApp.#onDeleteLodging,
      rentLodging:        CityManageApp.#onRentLodging,
      dismissLedgerEntry: CityManageApp.#onDismissLedgerEntry,
      configureMenu:        CityManageApp.#onConfigureMenu,
      refreshCourse:        CityManageApp.#onRefreshCourse,
      buyMenuItem:          CityManageApp.#onBuyMenuItem,
      restoreFromTemplate:         CityManageApp.#onRestoreFromTemplate,
      restoreFromMerchantTemplate: CityManageApp.#onRestoreFromMerchantTemplate,
      addMerchantItem:             CityManageApp.#onAddMerchantItem,
      deleteMerchantItem:     CityManageApp.#onDeleteMerchantItem,
      editMerchantItem:       CityManageApp.#onEditMerchantItem,
      addManualInventoryItem: CityManageApp.#onAddManualInventoryItem,
      switchToSellTab:        CityManageApp.#onSwitchToSellTab,
      addToSellCart:          CityManageApp.#onAddToSellCart,
      buyBackItem:            CityManageApp.#onBuyBackItem,
      editPurchasingProfile:  CityManageApp.#onEditPurchasingProfile,
      addExchangeToCart:      CityManageApp.#onAddExchangeToCart,
      depositCoins:           CityManageApp.#onDepositCoins,
      withdrawDeposit:        CityManageApp.#onWithdrawDeposit,
      overrideBankSettings:   CityManageApp.#onOverrideBankSettings,
      resetBankSettings:      CityManageApp.#onResetBankSettings
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/city-manage.hbs` }
  };

  // ------------------------------------------------------------------ context

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const scene = canvas.scene;
    const isGM = game.user.isGM;
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies = currencyConfig.currencies ?? [];

    context.isGM         = isGM;
    context.cityName     = scene?.getFlag(MODULE_ID, FLAGS.CITY_NAME) ?? "";
    context.cityTypes    = game.settings.get(MODULE_ID, SETTINGS.CITY_TYPES)
      .map(t => ({ value: t.name, label: t.name }));
    context.selectedType = scene?.getFlag(MODULE_ID, FLAGS.CITY_TYPE) ?? "";
    context.resources    = this.#enrichResources(isGM);
    context.selectedResource = await this.#buildSelectedResourceContext(currencies, isGM);
    return context;
  }

  #enrichResources(isGM = true) {
    const all = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const instances = isGM ? all : all.filter(r => r.discovered?.default === true);
    return instances.map(r => {
      const entries = getTypeEntries(r);
      const seenTypeIds = new Set();
      const types = entries
        .filter(e => !seenTypeIds.has(e.typeId) && seenTypeIds.add(e.typeId))
        .map(e => CORE_RESOURCE_TYPES.find(t => t.id === e.typeId))
        .filter(Boolean);
      return {
        ...r,
        typeName: types.map(t => t.name).join(" · ")
          || game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.unknownType"),
        typeIcon: types[0]?.icon ?? "fa-solid fa-question",
        selected: r.id === this._selectedResourceId
      };
    });
  }

  async #buildSelectedResourceContext(currencies, isGM = true) {
    const resource = this.#syncSelectedResource();
    if (!resource) return null;

    const rawEntries  = getTypeEntries(resource);
    const subTypeMap  = this.#getSubTypeMap();
    const selectedSet = new Set(rawEntries.map(e => `${e.typeId}::${e.subTypeId ?? ""}`));

    const typeEntries = rawEntries.map((entry, index) => {
      const coreType = CORE_RESOURCE_TYPES.find(t => t.id === entry.typeId);
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

    const pickerGroups = CORE_RESOURCE_TYPES.map(t => {
      const allSubTypes   = subTypeMap[t.id] ?? [];
      const availSubTypes = allSubTypes
        .filter(s => !selectedSet.has(`${t.id}::${s.id}`))
        .map(s => ({ id: s.id, name: s.name }));
      const typeItselfAvailable = !selectedSet.has(`${t.id}::`);
      return { typeId: t.id, name: t.name, icon: t.icon, typeItselfAvailable, subTypes: availSubTypes };
    }).filter(g => g.typeItselfAvailable || g.subTypes.length > 0);

    const typeIds = [...new Set(rawEntries.map(e => e.typeId))];
    const activeTab = this._activeTab ?? typeIds[0] ?? null;
    const tabs = await Promise.all(typeIds.map(async id => {
      const coreType       = CORE_RESOURCE_TYPES.find(t => t.id === id);
      const isCurrencyTest = id === RESOURCE_TYPE_IDS.CURRENCY_TEST;
      const isInn          = id === RESOURCE_TYPE_IDS.INN;
      const isMerchant     = id === RESOURCE_TYPE_IDS.MERCHANT;
      const isBank         = id === RESOURCE_TYPE_IDS.BANK;
      const firstEntry     = rawEntries.find(e => e.typeId === id);
      const subType        = firstEntry?.subTypeId
        ? (subTypeMap[id] ?? []).find(s => s.id === firstEntry.subTypeId) ?? null
        : null;
      const expenses = isCurrencyTest
        ? (resource.typeData?.expenses ?? []).map(e => {
            const c = currencies.find(x => x.id === e.currencyId);
            return { ...e, costLabel: `${e.amount} ${c?.abbreviation ?? "?"}` };
          })
        : [];
      return {
        id, active: id === activeTab,
        name:        coreType?.name ?? id,
        subTypeName: subType?.name ?? null,
        icon:        coreType?.icon ?? "fa-solid fa-question",
        typeId: id, isInn, isCurrencyTest, isMerchant, isBank,
        isOther: !isInn && !isCurrencyTest && !isMerchant && !isBank,
        expenses,
        innData:      isInn ? this.#buildInnData(resource, currencies, isGM) : null,
        bankData:     isBank ? this.#buildBankData(resource, currencies) : null,
        merchantData: await (async () => {
          if (!isMerchant) return null;
          const merchantResult = await this.#buildMerchantData(resource, currencies, isGM);
          if (merchantResult._needsSave && isGM) this.#saveMerchantData(merchantResult._updatedMerchant).catch(() => {});
          return merchantResult;
        })()
      };
    }));

    const innTemplate      = isGM ? this.#getTemplateForResource(resource)         : null;
    const merchantTemplate = isGM ? this.#getMerchantTemplateForResource(resource) : null;

    const effectiveProfile = mergePurchasingProfiles(resource);
    const hasSellTab = effectiveProfile.length > 0;
    let sellData = null;
    if (hasSellTab) {
      sellData = await this.#buildSellData(resource, currencies, isGM, effectiveProfile);
    }
    const sellTabActive = this._sellTabActive && hasSellTab;
    if (sellTabActive) {
      tabs.forEach(t => { t.active = false; });
    }

    return {
      id: resource.id,
      name: resource.name,
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

  #getTemplateForResource(resource) {
    const entry = getTypeEntries(resource).find(e => e.typeId === RESOURCE_TYPE_IDS.INN);
    if (!entry?.subTypeId) return null;
    const subTypes = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    return (subTypes[RESOURCE_TYPE_IDS.INN] ?? []).find(t => t.id === entry.subTypeId) ?? null;
  }

  #getMerchantTemplateForResource(resource) {
    const entry = getTypeEntries(resource).find(e => e.typeId === RESOURCE_TYPE_IDS.MERCHANT);
    if (!entry?.subTypeId) return null;
    const subTypes = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    return (subTypes[RESOURCE_TYPE_IDS.MERCHANT] ?? []).find(t => t.id === entry.subTypeId) ?? null;
  }

  #buildBankData(resource, currencies) {
    const bankRaw    = resource.typeData?.bank ?? {};
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
    const isOverridden = bankRaw._settingsOverridden ?? false;
    const bankEntry = getTypeEntries(resource).find(e => e.typeId === RESOURCE_TYPE_IDS.BANK);
    const subType = bankEntry?.subTypeId
      ? (this.#getSubTypeMap()[RESOURCE_TYPE_IDS.BANK] ?? []).find(s => s.id === bankEntry.subTypeId)
      : null;
    const hasTemplate = !!subType;
    const src = (isOverridden || !subType) ? bankRaw : (subType.typeData?.bank ?? {});
    const doesExchange    = src.doesExchange ?? false;
    const exchangeFee     = src.exchangeFee  ?? 0;
    const depositSettings = src.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 };

    const rawDeposits = depositSettings.global
      ? (game.world.getFlag(MODULE_ID, FLAGS.GLOBAL_DEPOSITS) ?? [])
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
      isOverridden,
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

  #buildInnData(resource, currencies, isGM = true) {
    const innRaw    = resource.typeData?.inn ?? { lodgings: [], ledger: [] };
    const { daysPerWeek, hoursPerDay } = getWorldTimeConfig();
    const worldTime = game.time.worldTime;

    const lodgings = (innRaw.lodgings ?? []).map(l => {
      const dayCurr     = currencies.find(c => c.id === l.pricePerDay?.currencyId);
      const dayLabel    = `${l.pricePerDay?.amount ?? 0} ${dayCurr?.abbreviation ?? "?"}`;
      const weeklyAmt   = l.pricePerWeek?.amount ?? ((l.pricePerDay?.amount ?? 0) * daysPerWeek);
      const weekCurr    = l.pricePerWeek ? currencies.find(c => c.id === l.pricePerWeek.currencyId) : dayCurr;
      const weekLabel   = `${weeklyAmt} ${weekCurr?.abbreviation ?? "?"}`;
      const avail       = l.availability ?? null;
      return {
        ...l,
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
      const timeRemainingLabel = isExpired
        ? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.expired")
        : (() => { const { totalDays, hour, minute } = secondsToComponents(remaining); return `${totalDays}d ${hour}h ${String(minute).padStart(2, "0")}m`; })();
      return { ...e, isExpired, timeRemainingLabel };
    });

    const menuData = this.#buildMenuData(innRaw, currencies, isGM, daysPerWeek, hoursPerDay, worldTime);
    if (menuData._needsSave && isGM) {
      const updatedInn = foundry.utils.deepClone(innRaw);
      updatedInn.menu = menuData._updatedMenu;
      this.#saveInnData(updatedInn).catch(() => {});
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

  // ------------------------------------------------------------------ render

  async _onRender(context, options) {
    await super._onRender(context, options);

    if (game.user.isGM) {
      this.element.querySelector('[name="cityName"]')?.addEventListener("change", e => {
        canvas.scene?.setFlag(MODULE_ID, FLAGS.CITY_NAME, e.target.value);
      });
      this.element.querySelector('[name="cityType"]')?.addEventListener("change", e => {
        canvas.scene?.setFlag(MODULE_ID, FLAGS.CITY_TYPE, e.target.value);
      });
      this.element.querySelector('[name="resourceName"]')?.addEventListener("change", async e => {
        const resource = this.#syncSelectedResource();
        if (!resource) return;
        const name = e.target.value.trim();
        if (!name) return;
        resource.name = name;
        await this.#saveResourceData(resource);
      });
      this.#setupTypePicker();
    }

    if (!this._sceneUpdateHook) {
      this._sceneUpdateHook = Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas.scene?.id) return;
        const resourcesChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.RESOURCES}`);
        const cityTypeChanged  = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.CITY_TYPE}`);
        if (!resourcesChanged && !cityTypeChanged) return;
        this.render({ parts: ["content"] });
      });
    }

    if (!this._worldTimeHook && game.user.isGM) {
      this._worldTimeHook = Hooks.on("updateWorldTime", () => this.render({ parts: ["content"] }));
    }

    // Wire sell actor select
    const sellActorSelect = this.element.querySelector('.ssm-sell-actor-select');
    if (sellActorSelect) {
      sellActorSelect.addEventListener('change', () => {
        this._sellActorId = sellActorSelect.value || null;
        this.render({ parts: ["content"] });
      });
    }

    // Wire bank actor select
    const bankActorSelect = this.element.querySelector('.ssm-bank-actor-select');
    if (bankActorSelect) {
      bankActorSelect.addEventListener('change', () => {
        this._bankActorId = bankActorSelect.value || null;
        this.render({ parts: ["content"] });
      });
    }

    // Wire bank exchange live preview
    const exchangeSection = this.element.querySelector('.ssm-bank-exchange');
    if (exchangeSection) this.#wireExchangePreview(exchangeSection);

    // Wire merchant drop zone
    const dropZone = this.element.querySelector(".merchant-drop-zone");
    if (dropZone) {
      dropZone.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; dropZone.classList.add("drag-over"); });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
      dropZone.addEventListener("drop",      e => { dropZone.classList.remove("drag-over"); this.#onMerchantDrop(e); });
    }
  }

  async _onClose(options) {
    await super._onClose(options);
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

    const trigger  = this.element.querySelector(".resource-add-type-trigger");
    const dropdown = trigger?.querySelector(".resource-type-picker-dropdown");
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
        const resource = this.#syncSelectedResource();
        if (!resource) return;
        const typeId   = item.dataset.typeId;
        const subTypeId = item.dataset.subTypeId || null;
        const entries  = getTypeEntries(resource);
        entries.push({ typeId, subTypeId });
        resource.typeEntries = entries;
        if (typeId === RESOURCE_TYPE_IDS.INN && !resource.typeData?.inn) {
          const subType = (this.#getSubTypeMap()[RESOURCE_TYPE_IDS.INN] ?? []).find(s => s.id === subTypeId);
          resource.typeData ??= {};
          resource.typeData.inn = {
            lodgings: foundry.utils.deepClone(subType?.typeData?.lodgings ?? []).map(l => ({
              ...l, templateItemId: l.id, overridden: false
            })),
            ledger: [],
            menu: {
              courses: foundry.utils.deepClone(subType?.typeData?.menu?.courses ?? []).map(c => ({
                ...c, templateItemId: c.id, overridden: false
              }))
            }
          };
        }
        if (typeId === RESOURCE_TYPE_IDS.MERCHANT && !resource.typeData?.merchant) {
          resource.typeData ??= {};
          resource.typeData.merchant = { inventory: [] };
        }
        dropdown.classList.remove("is-open");
        await this.#saveResourceData(resource);
      }, { signal });
    });
  }

  // ------------------------------------------------------------------ helpers

  #getSubTypeMap() {
    const raw = game.settings.get(MODULE_ID, SETTINGS.RESOURCE_TYPES);
    return Array.isArray(raw) ? {} : (raw ?? {});
  }

  #syncSelectedResource() {
    if (!this._selectedResourceId) return null;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    return resources.find(r => r.id === this._selectedResourceId) ?? null;
  }

  async #saveResourceData(updatedResource) {
    const scene = canvas.scene;
    if (!scene) return;
    if (game.user.isGM) {
      const resources = scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
      const index = resources.findIndex(r => r.id === updatedResource.id);
      if (index === -1) return;
      resources[index] = updatedResource;
      await scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
      this.render({ parts: ["content"] });
    } else {
      // Players lack scene write permission — route through the active GM.
      // The updateScene hook on all clients re-renders this app once the GM saves.
      game.socket.emit(SOCKET_CHANNEL, {
        type: SOCKET_TYPES.SAVE_RESOURCE,
        sceneId: scene.id,
        resource: updatedResource
      });
    }
  }

  async #saveInnData(innData) {
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    resource.typeData ??= {};
    resource.typeData.inn = innData;
    await this.#saveResourceData(resource);
  }

  async #buildMerchantData(resource, currencies, isGM = true) {
    const merchant       = resource.typeData?.merchant ?? {};
    const rawInventory   = merchant.inventory ?? [];
    const stockType        = merchant.stockType        ?? "percent";
    const restockFrequency = merchant.restockFrequency ?? "weekly";

    const itemConfig  = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);
    const typeConfigs = itemConfig.itemTypes ?? [];
    const typeMap     = Object.fromEntries(typeConfigs.map(t => [t.systemType, t]));

    const cityTypes       = game.settings.get(MODULE_ID, SETTINGS.CITY_TYPES) ?? [];
    const currentCityType = canvas.scene?.getFlag(MODULE_ID, FLAGS.CITY_TYPE) ?? "";
    const currentCityIdx  = cityTypes.findIndex(t => t.name === currentCityType);

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
      const min = item.minCitySize ?? "";
      if (!min) return true;
      const minIdx = cityTypes.findIndex(t => t.name === min);
      return minIdx === -1 || currentCityIdx >= minIdx;
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
    if (_needsSave) updatedMerchant.buybackItems = [];

    return {
      groups, flatInventory, isGM, hasGroups: typeConfigs.length > 0,
      _needsSave,
      _updatedMerchant: updatedMerchant
    };
  }

  async #buildSellData(resource, currencies, isGM, effectiveProfile) {
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

    const cityMaxDenomValue = getCityMaxDenomValue(currencies);

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
        const breakdown = calculateChange(saleStd, currencies, cityMaxDenomValue);
        const salePriceLabel = (breakdown && Object.values(breakdown).some(v => v > 0))
          ? formatAmounts(breakdown, currencies)
          : `${salePrice.amount} ${curr?.abbreviation ?? "?"}`;
        sellableItems.push({
          actorItemId:    actorItem.id,
          name:           actorItem.name,
          typeLabel:      typeCfg?.label ?? (actorItem.type ?? ""),
          itemLinkedUuid: actorItem.uuid,
          salePrice,
          salePriceLabel
        });
      }
    }

    const rawBuyback = resource.typeData?.merchant?.buybackItems ?? [];
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

  async #saveMerchantData(merchantData) {
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    resource.typeData ??= {};
    resource.typeData.merchant = merchantData;
    await this.#saveResourceData(resource);
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

    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const merchant = foundry.utils.deepClone(resource.typeData?.merchant ?? { inventory: [] });
    merchant.inventory.push({ id: foundry.utils.randomID(), name, price, itemId: item.uuid, quantity: null, itemType: item.type ?? null });
    resource.typeData ??= {};
    resource.typeData.merchant = merchant;
    await this.#saveResourceData(resource);
  }

  // ------------------------------------------------------------------ left pane actions

  static async #onAddResource() {
    if (!game.user.isGM) return;
    const result = await ResourceEditApp.open({});
    if (!result) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    resources.push(result);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    this._selectedResourceId = result.id;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteResource(event, target) {
    if (!game.user.isGM) return;
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const index = resources.findIndex(r => r.id === id);
    if (index === -1) return;
    const resource = resources[index];
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.deleteResourceTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.resource.deleteResourceConfirm", { name: resource.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    resources.splice(index, 1);
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    if (this._selectedResourceId === id) this._selectedResourceId = null;
    this.render({ parts: ["content"] });
  }

  static async #onToggleDiscovered(event, target) {
    if (!game.user.isGM) return;
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const resource = resources.find(r => r.id === id);
    if (!resource) return;
    resource.discovered.default = !resource.discovered.default;
    await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    const icon = target.querySelector("i");
    if (icon) icon.className = resource.discovered.default ? "fa-solid fa-eye" : "fa-regular fa-eye-slash";
    target.classList.toggle("is-discovered", resource.discovered.default);
  }

  static #onSelectResource(event, target) {
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id || id === this._selectedResourceId) return;
    this._selectedResourceId = id;
    this._activeTab    = null;
    this._sellTabActive = false;
    this._sellActorId   = null;
    this.render({ parts: ["content"] });
  }

  static #onSwitchTab(event, target) {
    this._activeTab     = target.dataset.tabId;
    this._sellTabActive = false;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteTypeEntry(event, target) {
    if (!game.user.isGM) return;
    const typeId = target.dataset.typeId;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const coreType = CORE_RESOURCE_TYPES.find(t => t.id === typeId);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.removeTypeTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.resource.removeTypeConfirm", { type: coreType?.name ?? typeId, resource: resource.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    resource.typeEntries = getTypeEntries(resource).filter(e => e.typeId !== typeId);
    if (resource.typeData?.[typeId]) delete resource.typeData[typeId];
    if (this._activeTab === typeId) this._activeTab = null;
    await this.#saveResourceData(resource);
  }

  static #onConfigureExpenses(event, target) {
    const id = target.closest("[data-resource-id]")?.dataset.resourceId;
    if (!id) return;
    const resources = canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
    const resource = resources.find(r => r.id === id);
    if (!resource) return;
    CurrencyTestConfigApp.open(resource, canvas.scene);
  }

  // ------------------------------------------------------------------ right pane actions

  static async #onRemoveTypeEntry(event, target) {
    if (!game.user.isGM) return;
    const index = parseInt(target.dataset.entryIndex);
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.removeEntryTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.resource.removeEntryConfirm", { name: resource.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    const entries = getTypeEntries(resource);
    entries.splice(index, 1);
    resource.typeEntries = entries;
    await this.#saveResourceData(resource);
  }

  static async #onAddLodging() {
    if (!game.user.isGM) return;
    const result = await LodgingEditApp.open({});
    if (!result) return;
    result.id ??= foundry.utils.randomID();
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    innData.lodgings.push(result);
    await this.#saveInnData(innData);
  }

  static async #onEditLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const resource = this.#syncSelectedResource();
    const innData  = foundry.utils.deepClone(resource?.typeData?.inn ?? { lodgings: [], ledger: [] });
    const index    = innData.lodgings.findIndex(l => l.id === lodgingId);
    if (index === -1) return;
    const lodging = innData.lodgings[index];
    const template = lodging.templateItemId ? this.#getTemplateForResource(resource) : null;
    const templateLodging = template
      ? (template.typeData?.lodgings ?? []).find(l => l.id === lodging.templateItemId) ?? null
      : null;
    const result = await LodgingEditApp.open(lodging, templateLodging);
    if (!result) return;
    if (result.templateItemId && !result._restored) result.overridden = true;
    delete result._restored;
    innData.lodgings[index] = result;
    await this.#saveInnData(innData);
  }

  static async #onDeleteLodging(event, target) {
    if (!game.user.isGM) return;
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    const lodging = innData.lodgings.find(l => l.id === lodgingId);
    if (!lodging) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.deleteLodgingTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.inn.deleteLodgingConfirm", { name: lodging.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    innData.lodgings = innData.lodgings.filter(l => l.id !== lodgingId);
    await this.#saveInnData(innData);
  }

  static async #onRentLodging(event, target) {
    const lodgingId = target.dataset.lodgingId;
    if (!lodgingId) return;
    const resource = this.#syncSelectedResource();
    const lodging  = resource?.typeData?.inn?.lodgings?.find(l => l.id === lodgingId);
    if (!lodging) return;
    cartManager.addLodging({
      sceneId: canvas.scene?.id,
      resourceId: resource.id,
      resourceName: resource.name,
      lodging
    });
    CartApp.open();
  }

  static async #onDismissLedgerEntry(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.entryId;
    if (!entryId) return;
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
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
    await this.#saveInnData(innData);
  }

  static async #onConfigureMenu() {
    if (!game.user.isGM) return;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const inn      = resource.typeData?.inn ?? { lodgings: [], ledger: [], menu: { courses: [] } };
    const template = this.#getTemplateForResource(resource);
    await MenuConfigApp.open(
      inn.menu ?? { courses: [] },
      async (updatedMenu) => {
        const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
        innData.menu = updatedMenu;
        await this.#saveInnData(innData);
      },
      template
    );
  }

  static async #onRestoreFromTemplate() {
    if (!game.user.isGM) return;
    const resource = this.#syncSelectedResource();
    const template = this.#getTemplateForResource(resource);
    if (!resource || !template) return;
    const innData = foundry.utils.deepClone(resource.typeData?.inn ?? { lodgings: [], ledger: [] });
    await TemplateRestoreDialog.open(innData, template, async (updatedInn) => {
      await this.#saveInnData(updatedInn);
    });
  }

  static async #onRestoreFromMerchantTemplate() {
    if (!game.user.isGM) return;
    const resource = this.#syncSelectedResource();
    const template = this.#getMerchantTemplateForResource(resource);
    if (!resource || !template) return;
    const merchantData = foundry.utils.deepClone(resource.typeData?.merchant ?? { inventory: [] });
    await MerchantRestoreDialog.open(merchantData, template, async (updated) => {
      await this.#saveMerchantData(updated);
    });
  }

  static async #onRefreshCourse(event, target) {
    if (!game.user.isGM) return;
    const courseId = target.dataset.courseId;
    if (!courseId) return;
    const innData = foundry.utils.deepClone(this.#syncSelectedResource()?.typeData?.inn ?? { lodgings: [], ledger: [] });
    const course = (innData.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course || course.mode !== "random") return;
    const shuffled = [...(course.pool ?? [])].sort(() => Math.random() - 0.5);
    course.drawnItems    = shuffled.slice(0, course.drawCount ?? 3);
    course.lastRefreshed = game.time.worldTime;
    await this.#saveInnData(innData);
  }

  static async #onBuyMenuItem(event, target) {
    const { courseId, itemId } = target.dataset;
    if (!courseId || !itemId) return;
    const resource = this.#syncSelectedResource();
    const inn = resource?.typeData?.inn;
    if (!inn) return;
    const course = (inn.menu?.courses ?? []).find(c => c.id === courseId);
    if (!course) return;
    const allItems = course.mode === "random" ? (course.drawnItems ?? []) : (course.items ?? []);
    const item = allItems.find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMenuItem({
      sceneId: canvas.scene?.id,
      resourceId: resource.id,
      resourceName: resource.name,
      course,
      item
    });
    CartApp.open();
  }

  static async #onAddMerchantItem(event, target) {
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const resource = this.#syncSelectedResource();
    const item = (resource?.typeData?.merchant?.inventory ?? []).find(i => i.id === itemId);
    if (!item) return;
    cartManager.addMerchantItem({
      sceneId: canvas.scene?.id,
      resourceId: resource.id,
      resourceName: resource.name,
      item
    });
    CartApp.open();
  }

  static async #onDeleteMerchantItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const merchant = foundry.utils.deepClone(resource.typeData?.merchant ?? { inventory: [] });
    const item = merchant.inventory.find(i => i.id === itemId);
    if (!item) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.removeItemTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.merchant.removeItemConfirm", { name: item.name })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.resource.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    merchant.inventory = merchant.inventory.filter(i => i.id !== itemId);
    await this.#saveMerchantData(merchant);
  }

  static async #onEditMerchantItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    const resource = this.#syncSelectedResource();
    const merchant = foundry.utils.deepClone(resource?.typeData?.merchant ?? { inventory: [] });
    const existing = merchant.inventory.find(i => i.id === itemId);
    if (!existing) return;
    const result = await MerchantItemEditApp.open(existing);
    if (!result) return;
    const idx = merchant.inventory.findIndex(i => i.id === itemId);
    if (idx !== -1) merchant.inventory[idx] = result;
    await this.#saveMerchantData(merchant);
  }

  static async #onAddManualInventoryItem() {
    if (!game.user.isGM) return;
    const result = await MerchantItemEditApp.open({});
    if (!result) return;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const merchant = foundry.utils.deepClone(resource.typeData?.merchant ?? { inventory: [] });
    merchant.inventory.push(result);
    resource.typeData ??= {};
    resource.typeData.merchant = merchant;
    await this.#saveResourceData(resource);
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
    const resource = this.#syncSelectedResource();
    if (!resource) return;

    const currencies       = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const effectiveProfile = mergePurchasingProfiles(resource);
    const rule = findEffectiveRule(effectiveProfile, actorItem.type ?? "");
    if (!rule) return;
    const salePrice = computeSalePrice(actorItem, rule, currencies);
    if (!salePrice) return;

    const qtyInput = this.element.querySelector(`.ssm-sell-qty[data-actor-item-id="${actorItemId}"]`);
    const qty = Math.max(1, parseInt(qtyInput?.value) || 1);

    cartManager.addSellItem({
      sceneId:        canvas.scene?.id,
      resourceId:     resource.id,
      resourceName:   resource.name,
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
    const resource = this.#syncSelectedResource();
    const buybackItems = resource?.typeData?.merchant?.buybackItems ?? [];
    const entry = buybackItems.find(b => b.id === buybackId);
    if (!entry || !entry.buybackPrice) return;
    cartManager.addMerchantItem({
      sceneId:      canvas.scene?.id,
      resourceId:   resource.id,
      resourceName: resource.name,
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
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    await PurchasingProfileEditApp.open(resource);
  }

  static async #onAddExchangeToCart(event, target) {
    if (!this._bankActorId) return;
    const section = this.element.querySelector('.ssm-bank-exchange');
    if (!section) return;
    const fromAmount     = parseInt(section.querySelector('[data-field="fromAmount"]')?.value) || 0;
    const fromCurrencyId = section.querySelector('[data-field="fromCurrency"]')?.value ?? "";
    const toCurrencyId   = section.querySelector('[data-field="toCurrency"]')?.value ?? "";
    if (!fromAmount || !fromCurrencyId || !toCurrencyId || fromCurrencyId === toCurrencyId) return;

    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const currencies   = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const bankData     = resource.typeData?.bank ?? {};
    const actor        = game.actors.get(this._bankActorId);
    if (!actor) return;

    cartManager.addExchange({
      sceneId:        canvas.scene?.id,
      resourceId:     resource.id,
      resourceName:   resource.name,
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
    const resource        = this.#syncSelectedResource();
    if (!resource) return;
    const bankRaw         = resource.typeData?.bank ?? {};
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
      resourceId: resource.id,
      sceneId:    canvas.scene?.id,
      isGlobal:   depositSettings.global ?? false
    };

    if (game.user.isGM) {
      await _handleRecordDeposit(payload);
    } else {
      game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.RECORD_DEPOSIT, payload });
    }

    for (const input of form.querySelectorAll('.ssm-deposit-amount-input')) input.value = '';
    this.render({ parts: ["content"] });
  }

  static async #onOverrideBankSettings() {
    if (!game.user.isGM) return;
    const resource     = this.#syncSelectedResource();
    if (!resource) return;
    const bankRaw      = resource.typeData?.bank ?? {};
    const isOverridden = bankRaw._settingsOverridden ?? false;
    const bankEntry    = getTypeEntries(resource).find(e => e.typeId === RESOURCE_TYPE_IDS.BANK);
    const subType      = bankEntry?.subTypeId
      ? (this.#getSubTypeMap()[RESOURCE_TYPE_IDS.BANK] ?? []).find(s => s.id === bankEntry.subTypeId)
      : null;
    const src  = (isOverridden || !subType) ? bankRaw : (subType.typeData?.bank ?? {});
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

    const bankData = foundry.utils.deepClone(resource.typeData?.bank ?? {});
    bankData.doesExchange        = result.doesExchange;
    bankData.exchangeFee         = result.exchangeFee;
    bankData.depositSettings     = {
      global:             result.depositGlobal,
      depositFee:         result.depositFee,
      minDepositDays:     result.minDepositDays,
      earlyWithdrawalFee: result.earlyWithdrawalFee
    };
    bankData._settingsOverridden = true;
    resource.typeData ??= {};
    resource.typeData.bank = bankData;
    await this.#saveResourceData(resource);
  }

  static async #onResetBankSettings() {
    if (!game.user.isGM) return;
    const resource = this.#syncSelectedResource();
    if (!resource) return;
    const bankData = foundry.utils.deepClone(resource.typeData?.bank ?? {});
    bankData._settingsOverridden = false;
    resource.typeData ??= {};
    resource.typeData.bank = bankData;
    await this.#saveResourceData(resource);
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
    const resource        = this.#syncSelectedResource();
    if (!resource) return;
    const bankRaw         = resource.typeData?.bank ?? {};
    const depositSettings = bankRaw.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 };
    const allDeposits     = depositSettings.global
      ? (game.world.getFlag(MODULE_ID, FLAGS.GLOBAL_DEPOSITS) ?? [])
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
      resourceId:     resource.id,
      sceneId:        canvas.scene?.id,
      isGlobal:       depositSettings.global ?? false
    };

    if (game.user.isGM) {
      await _handleProcessWithdrawal(payload);
    } else {
      game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.PROCESS_WITHDRAWAL, payload });
    }

    this.render({ parts: ["content"] });
  }
}
