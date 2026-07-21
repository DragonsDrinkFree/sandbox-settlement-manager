/**
 * Shared location data-building for the GM Settlement Manager (settlement-manage-app.js)
 * and the per-location interaction window (location-detail-app.js).
 *
 * Both windows render the same live location data (merchant inventory, bank, inn menu,
 * sell tab) from the scene flags; this module is the single source of truth for turning a
 * stored location entry into display-ready context. Previously each window carried its own
 * near-identical copy, which drifted apart (see git history); keep all shared build logic here.
 *
 * State note: bank and sell builders read/write per-window selection state
 * (`_bankActorId`, `_bankActorFilter`, `_sellActorId`, `_sellActorFilter`). The owning
 * app instance is passed in as `app` so that selection persists across renders exactly as
 * before. Persistence of restock/menu mutations stays in each app's own `#saveEntryData`
 * (single-location vs scene-array); these builders only return `_needsSave` / `_updated*`.
 */

import { MODULE_ID, FLAGS, SETTINGS, LOCATION_TYPE_IDS, getTypeEntries } from "../constants.js";
import { secondsToComponents, getWorldTimeConfig } from "../time/world-time.js";
import { readItemAttributes } from "../utils/item-utils.js";
import {
  costInStandard, calculateChange, formatAmounts, getSettlementMaxDenomValue,
  parseExchangeRate, getStandardCurrency
} from "../utils/currency-utils.js";
import { findEffectiveRule, computeSalePrice } from "./purchasing-utils.js";
import { isOverridden, instanceFromTemplate, snapshot, TEMPLATE_FIELDS } from "./template-link.js";
import { accrueLoan, computeOwedCoins } from "../utils/loan-utils.js";

/** The configured location sub-type map, guarded against the legacy array/undefined shape. */
export function getSubTypeMap() {
  const raw = game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES);
  return Array.isArray(raw) ? {} : (raw ?? {});
}

/**
 * Build the initial per-entry `typeData[entryId]` for a new location entry from its sub-type template.
 * Shared by both create paths (location-edit-app.js and settlement-manage-app.js's type picker) so the
 * two can't drift. Inn/merchant items are stamped as linked instances (templateItemId + _templateValues)
 * via instanceFromTemplate; the merchant entry also carries its own copy of the template's
 * purchasingProfile (each merchant tab is a single-use template — the Sell tab re-derives from these).
 */
export function buildEntryTypeData(typeId, subType) {
  if (typeId === LOCATION_TYPE_IDS.INN) {
    return {
      lodgings: (subType?.typeData?.lodgings ?? []).map(l => instanceFromTemplate(l, TEMPLATE_FIELDS.lodging)),
      ledger: [],
      menu: { courses: (subType?.typeData?.menu?.courses ?? []).map(c => instanceFromTemplate(c, TEMPLATE_FIELDS.course)) }
    };
  }
  if (typeId === LOCATION_TYPE_IDS.MERCHANT) {
    const tpl = subType?.typeData?.merchant ?? {};
    return {
      stockType:            tpl.stockType        ?? "percent",
      restockFrequency:     tpl.restockFrequency ?? "weekly",
      _tplStockType:        tpl.stockType        ?? "percent",
      _tplRestockFrequency: tpl.restockFrequency ?? "weekly",
      lastRestocked:        null,
      purchasingProfile:    foundry.utils.deepClone(tpl.purchasingProfile ?? []),
      inventory: (tpl.inventory ?? []).map(item => instanceFromTemplate(item, TEMPLATE_FIELDS.merchantItem, { quantity: null }))
    };
  }
  if (typeId === LOCATION_TYPE_IDS.BANK) {
    const tpl = subType?.typeData?.bank ?? {};
    const bankSettings = {
      doesExchange:    tpl.doesExchange ?? true,
      exchangeFee:     tpl.exchangeFee  ?? 0,
      depositSettings: tpl.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 }
    };
    return { ...bankSettings, _templateValues: snapshot(bankSettings, TEMPLATE_FIELDS.bank), deposits: [], loans: [] };
  }
  return {};
}

/** Collapse an actor's deposits into a single matured row plus per-deposit unmatured rows. */
export function buildDepositDisplayList(deposits, now, secondsPerDay, currencies) {
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

/**
 * Turn an actor's raw loan records into display rows. Offered loans show the pending terms with
 * Accept/Decline affordances; active loans are accrued on-read (pure) to show the current amount
 * owed and when the next interest charge lands. Payments/mutations persist elsewhere — this only
 * derives what to display, so it never writes.
 */
export function buildLoanDisplayList(loans, now, secondsPerDay, currencies) {
  const periodLabelKey = { day: "day", week: "week", month: "month" };
  return loans.map(raw => {
    const loan = accrueLoan(raw, now);
    const periodLabel = game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.bank.loans.period.${periodLabelKey[loan.periodUnit] ?? "week"}`);
    const rateLabel = game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.loans.ratePerPeriod", {
      rate: loan.interestRate, period: periodLabel
    });
    const principalLabel = formatAmounts(loan.principalCoins ?? {}, currencies);
    const common = {
      id:            loan.id,
      actorId:       loan.actorId,
      actorName:     loan.actorName,
      status:        loan.status,
      offered:       loan.status === "offered",
      active:        loan.status === "active",
      interestRate:  loan.interestRate,
      periodUnit:    loan.periodUnit,
      periodLabel,
      rateLabel,
      principalLabel
    };
    if (loan.status !== "active") return common;

    const owedCoins = computeOwedCoins(loan.balanceStandard, currencies);
    const nextInterestDays = Math.max(0, Math.ceil(((loan.lastAccrualAt ?? now) + loan.periodSeconds - now) / secondsPerDay));
    return {
      ...common,
      owedLabel:        formatAmounts(owedCoins, currencies),
      nextInterestDays,
      nextInterestLabel: game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.bank.loans.nextInterest", { days: nextInterestDays })
    };
  });
}

/**
 * Re-roll each inventory item's stock in place: an availability check (x-in-6 die or percent chance)
 * decides whether the item is in stock this cycle, then a stock formula (if any) sets the quantity —
 * items with no formula show ∞ (null) when available or 0 when sold out. Shared by the passive
 * restock timer in buildMerchantData and the GM's manual "Refresh Stock" action so both roll identically.
 */
export async function rollMerchantRestock(inventory, stockType) {
  for (const item of inventory) {
    const hasFormula = !!(item.stockFormula ?? "").trim();
    const avail = stockType === "x-in-6"
      ? (await new Roll("1d6").evaluate()).total <= (item.stockAvailability ?? 6)
      : Math.random() * 100 < (item.stockAvailability ?? 100);
    if (hasFormula) item.quantity = avail ? Math.floor((await new Roll(String(item.stockFormula)).evaluate()).total) : 0;
    else            item.quantity = avail ? null : 0; // null renders as ∞
  }
  return inventory;
}

/**
 * Build merchant inventory display data, restocking if due (GM only).
 * Items without a stock formula roll the availability % on restock and may show ∞ or sold out.
 * GMs see sold-out items sorted last; players don't see sold-out items at all.
 * Returns `_needsSave` / `_updatedMerchant`; the caller persists via its own #saveEntryData.
 */
export async function buildMerchantData(entry, location, currencies, isGM = true) {
  const merchant       = location.typeData?.[entry.id] ?? {};
  const rawInventory   = merchant.inventory ?? [];
  const stockType        = merchant.stockType        ?? "percent";
  const restockFrequency = merchant.restockFrequency ?? "weekly";

  const itemConfig  = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);
  const typeConfigs = itemConfig.itemTypes ?? [];
  const typeMap     = Object.fromEntries(typeConfigs.map(t => [t.systemType, t]));

  const settlementTypes       = game.settings.get(MODULE_ID, SETTINGS.SETTLEMENT_TYPES) ?? [];
  const currentSettlementType = canvas.scene?.getFlag(MODULE_ID, FLAGS.SETTLEMENT_TYPE) ?? "";
  const currentSettlementIdx  = settlementTypes.findIndex(t => t.name === currentSettlementType);

  const { hoursPerDay, daysPerWeek } = getWorldTimeConfig();
  const spd         = hoursPerDay * 3600;
  const cadenceSecs = { daily: spd, weekly: spd * daysPerWeek, monthly: spd * daysPerWeek * 4 }[restockFrequency] ?? spd;
  const restockDue  = isGM && (merchant.lastRestocked == null || game.time.worldTime >= merchant.lastRestocked + cadenceSecs);

  let _needsSave = false;
  const workingInventory = foundry.utils.deepClone(rawInventory);

  if (restockDue) {
    await rollMerchantRestock(workingInventory, stockType);
    _needsSave = true;
  }

  const displayInventory = workingInventory.filter(item => {
    const min = item.minSettlementSize ?? "";
    if (!min) return true;
    const minIdx = settlementTypes.findIndex(t => t.name === min);
    return minIdx === -1 || currentSettlementIdx >= minIdx;
  });

  // Cache UUID resolutions within this build pass so repeated/duplicate items don't each hit fromUuid.
  const uuidCache = new Map();
  const resolveItem = async (uuid) => {
    if (uuidCache.has(uuid)) return uuidCache.get(uuid);
    const fi = await fromUuid(uuid).catch(() => null);
    uuidCache.set(uuid, fi);
    return fi;
  };

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
      const fi = await resolveItem(item.itemId);
      if (fi) attrValues = readItemAttributes(fi, typeCfg);
    }

    const attrCells = (typeCfg?.attributes ?? []).map(a => ({
      id: a.id, label: a.label, value: attrValues[a.id] ?? "—"
    }));

    const isSoldOut  = item.quantity === 0;
    const stockLabel = item.quantity == null ? "∞" : String(item.quantity);

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

  const soldOutLast = (a, b) => (a.isSoldOut ? 1 : 0) - (b.isSoldOut ? 1 : 0);
  for (const group of groups) {
    if (isGM) {
      group.items.sort(soldOutLast);
    } else {
      group.items = group.items.filter(i => !i.isSoldOut);
    }
  }
  const visibleGroups = isGM ? groups : groups.filter(g => g.items.length > 0);

  const builtFlat = displayInventory.map(item => {
    let priceLabel = "—";
    if (item.price) {
      const curr = currencies.find(c => c.id === item.price.currencyId);
      priceLabel = `${item.price.amount} ${curr?.abbreviation ?? "?"}`;
    }
    const isSoldOut  = item.quantity === 0;
    const stockLabel = item.quantity == null ? "∞" : String(item.quantity);
    return { ...item, priceLabel, attrCells: [], stockLabel, isSoldOut };
  });
  const flatInventory = isGM
    ? builtFlat.sort(soldOutLast)
    : builtFlat.filter(i => !i.isSoldOut);

  const updatedMerchant = { ...merchant, inventory: workingInventory, lastRestocked: game.time.worldTime };
  if (_needsSave) updatedMerchant.buybackItems = []; // clear buyback cache on restock

  return {
    groups: visibleGroups, flatInventory, isGM, hasGroups: typeConfigs.length > 0,
    _needsSave,
    _updatedMerchant: updatedMerchant
  };
}

/**
 * Build bank display data for the active actor. Auto-selects a default actor (player character
 * or first owned/visible actor) when none is chosen yet, persisting the choice on `app`.
 */
export function buildBankData(app, entry, location, currencies) {
  const bankRaw    = location.typeData?.[entry.id] ?? {};
  const bankFilter = !game.user.isGM
    ? a => a.testUserPermission(game.user, "OWNER")
    : a => {
        if (app._bankActorFilter.playerOwned && !a.hasPlayerOwner) return false;
        if (app._bankActorFilter.types?.size && !app._bankActorFilter.types.has(a.type)) return false;
        return true;
      };
  const ownedActors = game.actors.filter(bankFilter).map(a => ({ id: a.id, name: a.name }));
  if (!app._bankActorId) {
    const defaultActor = game.user.character
      ?? game.actors.find(bankFilter)
      ?? null;
    if (defaultActor) app._bankActorId = defaultActor.id;
  }
  const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
  const mode = currencyConfig.mode ?? 'loose';
  const actor = app._bankActorId ? game.actors.get(app._bankActorId) : null;
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
  const standardCurrency = getStandardCurrency(currencies);

  // Resolve effective settings: template when not overridden, stored values when overridden
  const settingsOverridden = isOverridden(bankRaw, TEMPLATE_FIELDS.bank);
  const subType = entry.subTypeId
    ? (getSubTypeMap()[LOCATION_TYPE_IDS.BANK] ?? []).find(s => s.id === entry.subTypeId)
    : null;
  const hasTemplate = !!subType;
  const src = (settingsOverridden || !subType) ? bankRaw : (subType.typeData?.bank ?? {});
  const doesExchange    = src.doesExchange ?? false;
  const exchangeFee     = src.exchangeFee  ?? 0;
  const depositSettings = src.depositSettings ?? { global: false, depositFee: 0, minDepositDays: 0, earlyWithdrawalFee: 0 };

  const rawDeposits = depositSettings.global
    ? (game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [])
    : (bankRaw.deposits ?? []);
  const actorDeposits = app._bankActorId ? rawDeposits.filter(d => d.actorId === app._bankActorId) : [];
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

  const rawLoans   = bankRaw.loans ?? [];
  const actorLoans = app._bankActorId ? rawLoans.filter(l => l.actorId === app._bankActorId) : [];
  const processedLoans = buildLoanDisplayList(actorLoans, now, secondsPerDay, currencies);

  return {
    doesExchange,
    exchangeFee,
    currencies:           currencies.map(c => {
      const bal = balances.find(b => b.id === c.id);
      return { id: c.id, name: c.name, abbreviation: c.abbreviation, exchangeRate: c.exchangeRate, balance: bal?.amount ?? 0 };
    }),
    ownedActors,
    selectedActorId:      app._bankActorId ?? null,
    balances,
    defaultFromCurrencyId: lowestCurrency?.id ?? null,
    defaultToCurrencyId:   standardCurrency?.id ?? null,
    depositSettings,
    processedDeposits,
    depositsTotal,
    processedLoans,
    hasLoans: processedLoans.length > 0,
    isOverridden: settingsOverridden,
    hasTemplate,
    isGM: game.user.isGM,
    selectedActorName: game.actors.get(app._bankActorId)?.name ?? null,
    filterActive: game.user.isGM && (!app._bankActorFilter.playerOwned || app._bankActorFilter.types !== null)
  };
}

/**
 * Build inn display data (lodgings, ledger, menu). Menu courses in random mode refresh when due
 * (GM only). Returns `_needsSave` / `_updatedInn` so the caller persists the refreshed menu.
 */
export function buildInnData(entry, location, currencies, isGM = true) {
  const innRaw    = location.typeData?.[entry.id] ?? { lodgings: [], ledger: [] };
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
    : allLedger.filter(e => {
        const actor = game.actors.get(e.actorId);
        return actor?.testUserPermission(game.user, "OWNER");
      });

  const ledger = visibleLedger.map(e => {
    const remaining = e.expiresAt - worldTime;
    const isExpired = remaining <= 0;
    const timeRemainingLabel = isExpired
      ? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.expired")
      : (() => { const { totalDays, hour, minute } = secondsToComponents(remaining); return `${totalDays}d ${hour}h ${String(minute).padStart(2, "0")}m`; })();
    return { ...e, isExpired, timeRemainingLabel };
  });

  const menuData = buildMenuData(innRaw, currencies, isGM, daysPerWeek, hoursPerDay, worldTime);
  let _needsSave = false;
  let _updatedInn = null;
  if (menuData._needsSave && isGM) {
    _updatedInn = foundry.utils.deepClone(innRaw);
    _updatedInn.menu = menuData._updatedMenu;
    _needsSave = true;
  }

  return { lodgings, ledger, isGM, menuData, _needsSave, _updatedInn };
}

/** Build inn menu display data; refreshes random courses (drawing drawCountMin..drawCountMax) when due. */
function buildMenuData(innRaw, currencies, isGM, daysPerWeek, hoursPerDay, worldTime) {
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
        const dcMin = course.drawCountMin ?? course.drawCount ?? 1;
        const dcMax = course.drawCountMax ?? course.drawCount ?? dcMin;
        const dcCount = dcMin >= dcMax ? dcMin : Math.floor(Math.random() * (dcMax - dcMin + 1)) + dcMin;
        course.drawnItems    = shuffled.slice(0, Math.min(dcCount, shuffled.length));
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

/**
 * Build the sell-tab display data: items the selected actor can sell here, plus merchant buyback
 * items. Auto-selects a default actor when none is chosen, persisting the choice on `app`.
 */
export async function buildSellData(app, location, currencies, isGM, effectiveProfile) {
  const hasConflicts = effectiveProfile.some(r => r._conflicted || r._buybackConflicted);

  const sellFilter = !game.user.isGM
    ? a => a.testUserPermission(game.user, "OWNER")
    : a => {
        if (app._sellActorFilter.playerOwned && !a.hasPlayerOwner) return false;
        if (app._sellActorFilter.types?.size && !app._sellActorFilter.types.has(a.type)) return false;
        return true;
      };
  const ownedActors = game.actors.filter(sellFilter);
  const defaultActor = (app._sellActorId ? game.actors.get(app._sellActorId) : null)
    ?? game.user.character
    ?? ownedActors[0]
    ?? null;
  if (defaultActor && !app._sellActorId) app._sellActorId = defaultActor.id;

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
        actorItemId:    actorItem.id,
        name:           actorItem.name,
        typeLabel:      typeCfg?.label ?? (actorItem.type ?? ""),
        itemLinkedUuid: actorItem.uuid,
        salePrice,
        salePriceLabel
      });
    }
  }

  const merchantEntries = getTypeEntries(location).filter(e => e.typeId === LOCATION_TYPE_IDS.MERCHANT);
  const rawBuyback = merchantEntries.flatMap(me =>
    (location.typeData?.[me.id]?.buybackItems ?? []).map(b => ({ ...b, _entryId: me.id }))
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

  return {
    effectiveProfile, hasConflicts, actors: actorOptions, selectedActorId: defaultActor?.id ?? null, sellableItems, buybackItems,
    filterActive: game.user.isGM && (!app._sellActorFilter.playerOwned || app._sellActorFilter.types !== null)
  };
}
