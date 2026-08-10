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
import { computeItemWeight, computeGroupUsedWeight, resolveEffectivePolicy, canRetrieve, getGroupAccessList, canManageGuests } from "../utils/storage-utils.js";

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
    const innTpl = subType?.typeData ?? {};
    return {
      lodgings: (subType?.typeData?.lodgings ?? []).map(l => instanceFromTemplate(l, TEMPLATE_FIELDS.lodging, { storageNextAreaNumber: 1 })),
      ledger: [],
      menu: { courses: (subType?.typeData?.menu?.courses ?? []).map(c => instanceFromTemplate(c, TEMPLATE_FIELDS.course)) },
      // Lodging-level price-variation config (single set for all lodgings) + its refresh cadence.
      lodgingPriceVarMin:        innTpl.lodgingPriceVarMin        ?? 0,
      lodgingPriceVarMax:        innTpl.lodgingPriceVarMax        ?? 0,
      lodgingPriceVarIndividual: innTpl.lodgingPriceVarIndividual ?? false,
      lodgingPriceVarRounding:   innTpl.lodgingPriceVarRounding   ?? "same",
      lodgingRefreshCadence:     innTpl.lodgingRefreshCadence     ?? "weekly",
      lodgingLastRefreshed:      null,
      // Which Storage entry on this same Location this Inn is linked to, if any (stamped by the
      // attach-site caller right after this is built — see ensureLinkedStorageEntry below).
      linkedStorageEntryId:      null
    };
  }
  if (typeId === LOCATION_TYPE_IDS.MERCHANT) {
    const tpl = subType?.typeData?.merchant ?? {};
    return {
      stockType:            tpl.stockType        ?? "percent",
      restockFrequency:     tpl.restockFrequency ?? "weekly",
      _tplStockType:        tpl.stockType        ?? "percent",
      _tplRestockFrequency: tpl.restockFrequency ?? "weekly",
      priceVarMin:            tpl.priceVarMin        ?? 0,
      priceVarMax:            tpl.priceVarMax        ?? 0,
      priceVarIndividual:     tpl.priceVarIndividual ?? false,
      priceVarRounding:       tpl.priceVarRounding   ?? "same",
      _tplPriceVarMin:        tpl.priceVarMin        ?? 0,
      _tplPriceVarMax:        tpl.priceVarMax        ?? 0,
      _tplPriceVarIndividual: tpl.priceVarIndividual ?? false,
      _tplPriceVarRounding:   tpl.priceVarRounding   ?? "same",
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
  if (typeId === LOCATION_TYPE_IDS.STORAGE) {
    const tpl = subType?.typeData?.storage ?? {};
    return {
      storageTypes: (tpl.storageTypes ?? []).map(st => instanceFromTemplate(st, TEMPLATE_FIELDS.storageType)),
      groups: [],
      items: []
    };
  }
  return {};
}

/**
 * Given an already-resolved Storage template id, ensure `entries` has a matching Storage entry —
 * reusing one already attached from that same Storage template if present, otherwise pushing a new
 * one. Mutates `entries` in place (push only, never removes). Returns the Storage entry's id, or
 * null if `linkedTemplateId` is null.
 */
export function ensureStorageEntryForTemplate(entries, linkedTemplateId) {
  if (!linkedTemplateId) return null;

  const existing = entries.find(e => e.typeId === LOCATION_TYPE_IDS.STORAGE && e.subTypeId === linkedTemplateId);
  if (existing) return existing.id;

  const newEntry = { id: foundry.utils.randomID(), typeId: LOCATION_TYPE_IDS.STORAGE, subTypeId: linkedTemplateId };
  entries.push(newEntry);
  return newEntry.id;
}

/**
 * If `typeId`/`subTypeId` is an Inn template with a linked Storage template, ensure a matching
 * Storage entry exists in `entries` (see ensureStorageEntryForTemplate). Forward-only by design: only
 * called at the moment an Inn entry is newly attached, never re-checked for pre-existing Inn entries
 * (see reconcileLinkedStorageForEntry for that). Returns the Storage entry's id, or null if this
 * isn't a linked Inn.
 */
export function ensureLinkedStorageEntry(entries, typeId, subTypeId, subTypeMap) {
  if (typeId !== LOCATION_TYPE_IDS.INN) return null;
  const innSubType = (subTypeMap[LOCATION_TYPE_IDS.INN] ?? []).find(s => s.id === subTypeId);
  return ensureStorageEntryForTemplate(entries, innSubType?.typeData?.linkedStorageTemplateId ?? null);
}

/**
 * After saving an Inn entry's own local config (SubTypeEditApp.openForEntry), ensure its
 * linkedStorageTemplateId (if any) has a matching Storage entry attached to this Location — reusing
 * one already attached if present, else creating a new typeEntries item. Mutates
 * `location.typeEntries` in place and stamps `innResult.linkedStorageEntryId`. Returns
 * { id, data, typeEntries } describing a brand-new Storage entry that still needs its typeData
 * persisted by the caller, or null if nothing new is needed (already linked, or no link configured).
 */
export function reconcileLinkedStorageForEntry(location, innResult, subTypeMap) {
  const entries = getTypeEntries(location);
  const linkedStorageEntryId = ensureStorageEntryForTemplate(entries, innResult.linkedStorageTemplateId ?? null);
  innResult.linkedStorageEntryId = linkedStorageEntryId;
  location.typeEntries = entries;
  if (!linkedStorageEntryId || location.typeData?.[linkedStorageEntryId]) return null;

  const storageEntry = entries.find(e => e.id === linkedStorageEntryId);
  const storageSubType = (subTypeMap[LOCATION_TYPE_IDS.STORAGE] ?? []).find(s => s.id === storageEntry?.subTypeId);
  return { id: linkedStorageEntryId, data: buildEntryTypeData(LOCATION_TYPE_IDS.STORAGE, storageSubType), typeEntries: entries };
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

/** Random integer percent within [min, max], inclusive of both bounds; tolerates min > max. */
function pickPct(min = 0, max = 0) {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

/**
 * Turn an authored price + adjustment percent into a live price with a coin breakdown, per the
 * chosen rounding mode. Returns `{ currencyId, amount, coins }` where `amount` is the value in the
 * base denomination (used for charging — its standard value equals the coins' total) and `coins`
 * is the display breakdown `{ [currencyId]: count }`.
 *
 * Modes:
 *  - "same"  keep the base denomination, round away from base (increase→up, decrease→down).
 *  - "lower" keep the whole base part; express the remainder in the next-lower denomination (nearest).
 *  - "all"   break down through every denomination to the lowest (nearest at the finest coin).
 * When there is no lower denomination available, "lower"/"all" degrade to "same".
 */
function computeAdjustedPrice(basePrice, pct, rounding, currencies) {
  const base     = currencies.find(c => c.id === basePrice.currencyId);
  const baseRate = parseExchangeRate(base?.exchangeRate) || 1;
  const rawStd   = basePrice.amount * (1 + pct / 100) * baseRate;

  const lowerDenoms = currencies.filter(c => parseExchangeRate(c.exchangeRate) < baseRate);
  let allowed;
  if (rounding === "all") {
    allowed = currencies.filter(c => parseExchangeRate(c.exchangeRate) <= baseRate);
  } else if (rounding === "lower" && lowerDenoms.length) {
    const next = lowerDenoms.reduce((a, b) => parseExchangeRate(a.exchangeRate) >= parseExchangeRate(b.exchangeRate) ? a : b);
    allowed = [base, next];
  } else {
    allowed = [base];
  }
  const floorRate = Math.min(...allowed.map(c => parseExchangeRate(c.exchangeRate)));

  const q = rawStd / floorRate;
  const n = rounding === "same"
    ? (pct >= 0 ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9)) // away from base
    : Math.round(q);                                          // nearest
  const roundedStd = Math.max(0, n) * floorRate;

  const coins = calculateChange(roundedStd, allowed, baseRate) ?? { [base.id]: Math.max(0, Math.round(q)) };
  return { currencyId: base.id, amount: roundedStd / baseRate, coins };
}

/**
 * Roll each merchant item's live sale price from its authored `price`, storing the result on the
 * runtime `currentPrice` (authored `price` is never overwritten). With `individual` off a single
 * store-wide percent applies to every item; with it on each item rolls its own percent from the
 * same range. The `rounding` mode governs how the adjusted value is expressed as coins.
 * Called on every full restock (timed + manual), not on item edits.
 */
export function applyPriceVariation(inventory, { min = 0, max = 0, individual = false, rounding = "same" } = {}, currencies = []) {
  const noVariation = min === 0 && max === 0;
  const storePct = individual ? null : pickPct(min, max);
  for (const item of inventory) {
    if (!item.price) continue;
    if (noVariation) { delete item.currentPrice; continue; } // no adjustment → fall back to the authored price
    const pct = individual ? pickPct(min, max) : storePct;
    item.currentPrice = computeAdjustedPrice(item.price, pct, rounding, currencies);
  }
  return inventory;
}

/**
 * Roll each purchasing-profile rule's buy-back percent within its [buyRate, buyRateMax] range,
 * stamping the runtime `_rolledBuyRate` the sale-price computation reads. A disabled rule
 * (`buyRate == null`) stays disabled. Re-rolled every restock alongside stock/prices.
 */
export function rollMerchantBuyRates(purchasingProfile) {
  for (const rule of purchasingProfile ?? []) {
    if (rule.buyRate == null) { rule._rolledBuyRate = null; continue; }
    rule._rolledBuyRate = pickPct(rule.buyRate ?? 0, rule.buyRateMax ?? rule.buyRate ?? 0);
  }
  return purchasingProfile;
}

/** Read the merchant-level price-variation config off a stored merchant entry, with defaults. */
export function readPriceVarConfig(merchant) {
  return {
    min:        merchant?.priceVarMin ?? 0,
    max:        merchant?.priceVarMax ?? 0,
    individual: merchant?.priceVarIndividual ?? false,
    rounding:   merchant?.priceVarRounding ?? "same"
  };
}

/** Read the inn's lodging-level price-variation config off a stored inn entry, with defaults. */
function readLodgingPriceVarConfig(inn) {
  return {
    min:        inn?.lodgingPriceVarMin ?? 0,
    max:        inn?.lodgingPriceVarMax ?? 0,
    individual: inn?.lodgingPriceVarIndividual ?? false,
    rounding:   inn?.lodgingPriceVarRounding ?? "same"
  };
}

/** Read a course's own price-variation config, with defaults. */
function readCoursePriceVarConfig(course) {
  return {
    min:        course?.priceVarMin ?? 0,
    max:        course?.priceVarMax ?? 0,
    individual: course?.priceVarIndividual ?? false,
    rounding:   course?.priceVarRounding ?? "same"
  };
}

/**
 * Roll live lodging prices from the authored pricePerDay / pricePerWeek onto runtime
 * `currentPricePerDay` / `currentPricePerWeek` (each `{ currencyId, amount, coins }`). One percent
 * per lodging applies to both its day and week price; `individual` off shares one store-wide percent.
 * Weekly falls back to day × daysPerWeek when the lodging has no explicit weekly price.
 */
function applyLodgingPriceVariation(lodgings, { min = 0, max = 0, individual = false, rounding = "same" } = {}, currencies = [], daysPerWeek = 7) {
  const noVar = min === 0 && max === 0;
  const storePct = individual ? null : pickPct(min, max);
  for (const l of lodgings) {
    if (noVar) { delete l.currentPricePerDay; delete l.currentPricePerWeek; continue; }
    const pct = individual ? pickPct(min, max) : storePct;
    if (l.pricePerDay) l.currentPricePerDay = computeAdjustedPrice(l.pricePerDay, pct, rounding, currencies);
    const weekBase = l.pricePerWeek
      ?? (l.pricePerDay ? { currencyId: l.pricePerDay.currencyId, amount: l.pricePerDay.amount * daysPerWeek } : null);
    if (weekBase) l.currentPricePerWeek = computeAdjustedPrice(weekBase, pct, rounding, currencies);
  }
  return lodgings;
}

/**
 * Roll live prices for a course's active items (drawnItems in random mode, `items` in fixed mode)
 * onto each item's runtime `currentPrice`, computed from its effective base `item.price ?? course.price`.
 * `individual` off shares one store-wide percent across the course; on rolls per item.
 */
function applyCoursePriceVariation(course, { min = 0, max = 0, individual = false, rounding = "same" } = {}, currencies = []) {
  const active = course.mode === "random" ? (course.drawnItems ?? []) : (course.items ?? []);
  const noVar = min === 0 && max === 0;
  const storePct = individual ? null : pickPct(min, max);
  for (const item of active) {
    const base = item.price ?? course.price;
    if (!base || noVar) { delete item.currentPrice; continue; }
    const pct = individual ? pickPct(min, max) : storePct;
    item.currentPrice = computeAdjustedPrice(base, pct, rounding, currencies);
  }
  return course;
}

/** Re-draw a random course's items from its pool, honoring drawCountMin..drawCountMax. */
function drawCourseItems(course) {
  if (course.mode !== "random" || !(course.pool ?? []).length) return;
  const shuffled = [...course.pool].sort(() => Math.random() - 0.5);
  const dcMin = course.drawCountMin ?? course.drawCount ?? 1;
  const dcMax = course.drawCountMax ?? course.drawCount ?? dcMin;
  const dcCount = dcMin >= dcMax ? dcMin : Math.floor(Math.random() * (dcMax - dcMin + 1)) + dcMin;
  course.drawnItems = shuffled.slice(0, Math.min(dcCount, shuffled.length));
}

/**
 * Force an immediate inn refresh regardless of any cadence (the manual "Refresh" button): re-roll
 * lodging prices, re-draw each random course, and re-roll every course's prices, stamping the
 * refresh timestamps. Mutates `inn` in place. Mirrors the merchant force-restock button.
 */
export function forceRefreshInn(inn, currencies) {
  const { daysPerWeek } = getWorldTimeConfig();
  const now = game.time.worldTime;

  const lodgingCfg = readLodgingPriceVarConfig(inn);
  applyLodgingPriceVariation(inn.lodgings ?? [], lodgingCfg, currencies, daysPerWeek);
  inn.lodgingLastRefreshed = now;

  for (const course of inn.menu?.courses ?? []) {
    drawCourseItems(course);
    applyCoursePriceVariation(course, readCoursePriceVarConfig(course), currencies);
    course.lastRefreshed = now;
  }
  return inn;
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
  let workingProfile = null;

  if (restockDue) {
    await rollMerchantRestock(workingInventory, stockType);
    applyPriceVariation(workingInventory, readPriceVarConfig(merchant), currencies);
    workingProfile = rollMerchantBuyRates(foundry.utils.deepClone(merchant.purchasingProfile ?? []));
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
    if (item.currentPrice?.coins) {
      priceLabel = formatAmounts(item.currentPrice.coins, currencies);
    } else if (item.price) {
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
    if (item.currentPrice?.coins) {
      priceLabel = formatAmounts(item.currentPrice.coins, currencies);
    } else if (item.price) {
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
  if (_needsSave) {
    updatedMerchant.buybackItems = []; // clear buyback cache on restock
    if (workingProfile) updatedMerchant.purchasingProfile = workingProfile; // persist rolled buy rates
  }

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
 * Build storage display data: resolved storage types (with override flags), and — for the
 * groups the current user can see — effective retrieval policy, used/total weight, and items
 * grouped by depositor (so cooperative players can see who put what in). GM sees every group;
 * a non-GM sees only groups where one of their owned actors is on the access list.
 */
export function buildStorageData(app, entry, location) {
  const storage = location.typeData?.[entry.id] ?? { storageTypes: [], groups: [], items: [] };

  const storageTypes = (storage.storageTypes ?? []).map(st => ({
    ...st,
    weightLimitLabel: (st.weightLimit === null || st.weightLimit === undefined) ? "∞" : st.weightLimit,
    overridden: isOverridden(st, TEMPLATE_FIELDS.storageType)
  }));

  const isGM = game.user.isGM;
  const myActorIds = game.actors.filter(a => a.testUserPermission(game.user, "OWNER")).map(a => a.id);

  const visibleGroups = isGM
    ? (storage.groups ?? [])
    : (storage.groups ?? []).filter(g => getGroupAccessList(g).some(a => myActorIds.includes(a.actorId)));

  const groups = visibleGroups.map(group => {
    const storageType = storageTypes.find(st => st.id === group.storageTypeId) ?? null;
    const effectivePolicy = resolveEffectivePolicy(group, storageType);
    const usedWeight = computeGroupUsedWeight(storage.items, group.id);
    const weightLabel = !storageType
      ? "—"
      : (storageType.weightLimit === null || storageType.weightLimit === undefined)
        ? `${usedWeight} / ∞`
        : `${usedWeight} / ${storageType.weightLimit}`;

    const groupItems = (storage.items ?? []).filter(i => i.groupId === group.id).map(item => {
      const takeableByMyActors = game.actors
        .filter(a => a.isOwner && canRetrieve(item, group, storageType, a.id))
        .map(a => ({ id: a.id, name: a.name }));
      const ownershipMode = item.ownership?.mode ?? "private";
      return {
        ...item,
        itemName:            item.itemData?.name ?? "",
        depositorName:       item.depositedByActorName ?? "",
        weight:              computeItemWeight(item.itemData, item.quantity),
        showQuantity:        (item.quantity ?? 1) > 1,
        canTake:             takeableByMyActors.length > 0,
        takeableByMyActors,
        canManageOwnership:  isGM || myActorIds.includes(item.depositedByActorId),
        isGroupProperty:     ownershipMode === "group",
        isAssigned:          ownershipMode === "assigned",
        // "group" mode is conveyed by the Group Accessible checkbox itself — no separate badge needed.
        ownershipLabel: ownershipMode === "assigned"
          ? game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.storage.item.assignedBadge", { name: item.ownership?.assignedToActorName ?? "?" })
          : null
      };
    });

    const byDepositor = new Map();
    for (const item of groupItems) {
      const key = item.depositedByActorId ?? "";
      if (!byDepositor.has(key)) {
        byDepositor.set(key, { actorId: item.depositedByActorId, actorName: item.depositorName, items: [] });
      }
      byDepositor.get(key).items.push(item);
    }

    return {
      id:                      group.id,
      name:                    group.name,
      storageTypeId:           group.storageTypeId,
      storageTypeName:         storageType?.name ?? "—",
      access: getGroupAccessList(group).map(a => ({
        actorId:   a.actorId,
        actorName: game.actors.get(a.actorId)?.name ?? "?",
        level:     a.level,
        isPrimary: a.level === "primary"
      })).sort((a, b) => (a.isPrimary === b.isPrimary) ? a.actorName.localeCompare(b.actorName) : (a.isPrimary ? -1 : 1)),
      canManageGuests:         isGM || canManageGuests(group, myActorIds),
      note:                    group.note ?? "",
      hasNote:                 !!(group.note && group.note.trim()),
      retrievalPolicyOverride: group.retrievalPolicyOverride ?? null,
      effectivePolicy,
      usedWeight,
      weightLabel,
      itemCount:               groupItems.length,
      depositors:              [...byDepositor.values()]
    };
  });

  return {
    storageTypes,
    hasStorageTypes: storageTypes.length > 0,
    groups,
    hasGroups: groups.length > 0,
    isGM
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

  // --- Lodging price variation: re-roll on the lodging refresh cadence (GM only) ---
  const workingLodgings = foundry.utils.deepClone(innRaw.lodgings ?? []);
  const lodgingCfg    = readLodgingPriceVarConfig(innRaw);
  const hasLodgingVar = lodgingCfg.min !== 0 || lodgingCfg.max !== 0;
  let _lodgingNeedsSave = false;
  let _lodgingRefreshed = false;
  if (isGM) {
    if (hasLodgingVar) {
      const spd = hoursPerDay * 3600;
      const cadenceSecs = { daily: spd, weekly: spd * daysPerWeek, monthly: spd * daysPerWeek * 4 }[innRaw.lodgingRefreshCadence ?? "weekly"] ?? spd * daysPerWeek;
      const due = innRaw.lodgingLastRefreshed == null || worldTime >= innRaw.lodgingLastRefreshed + cadenceSecs;
      if (due) {
        applyLodgingPriceVariation(workingLodgings, lodgingCfg, currencies, daysPerWeek);
        _lodgingNeedsSave = true;
        _lodgingRefreshed = true;
      }
    } else if (workingLodgings.some(l => l.currentPricePerDay || l.currentPricePerWeek)) {
      // Variation turned off — drop stale adjusted prices so authored prices show again.
      for (const l of workingLodgings) { delete l.currentPricePerDay; delete l.currentPricePerWeek; }
      _lodgingNeedsSave = true;
    }
  }

  const lodgings = workingLodgings.map(l => {
    const dayCurr     = currencies.find(c => c.id === l.pricePerDay?.currencyId);
    const dayLabel    = l.currentPricePerDay?.coins
      ? formatAmounts(l.currentPricePerDay.coins, currencies)
      : `${l.pricePerDay?.amount ?? 0} ${dayCurr?.abbreviation ?? "?"}`;
    const weeklyAmt   = l.pricePerWeek?.amount ?? ((l.pricePerDay?.amount ?? 0) * daysPerWeek);
    const weekCurr    = l.pricePerWeek ? currencies.find(c => c.id === l.pricePerWeek.currencyId) : dayCurr;
    const weekLabel   = l.currentPricePerWeek?.coins
      ? formatAmounts(l.currentPricePerWeek.coins, currencies)
      : `${weeklyAmt} ${weekCurr?.abbreviation ?? "?"}`;
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
  if ((menuData._needsSave || _lodgingNeedsSave) && isGM) {
    _updatedInn = foundry.utils.deepClone(innRaw);
    if (menuData._needsSave) _updatedInn.menu = menuData._updatedMenu;
    if (_lodgingNeedsSave) {
      _updatedInn.lodgings = workingLodgings;
      if (_lodgingRefreshed) _updatedInn.lodgingLastRefreshed = worldTime;
    }
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
    const priceCfg = readCoursePriceVarConfig(course);
    const hasPriceVar = priceCfg.min !== 0 || priceCfg.max !== 0;

    // Refresh cadence: random mode re-draws items; either mode re-rolls prices when variation is set.
    if (isGM && (isRandom || hasPriceVar)) {
      const cadenceSecs = course.refreshCadence === "weekly" ? secondsPerWeek : secondsPerDay;
      const due = worldTime >= (course.lastRefreshed ?? 0) + cadenceSecs;
      if (due) {
        let changed = false;
        if (isRandom && (course.pool ?? []).length > 0) {
          const shuffled = [...(course.pool ?? [])].sort(() => Math.random() - 0.5);
          const dcMin = course.drawCountMin ?? course.drawCount ?? 1;
          const dcMax = course.drawCountMax ?? course.drawCount ?? dcMin;
          const dcCount = dcMin >= dcMax ? dcMin : Math.floor(Math.random() * (dcMax - dcMin + 1)) + dcMin;
          course.drawnItems = shuffled.slice(0, Math.min(dcCount, shuffled.length));
          changed = true;
        }
        if (hasPriceVar) { applyCoursePriceVariation(course, priceCfg, currencies); changed = true; }
        if (changed) { course.lastRefreshed = worldTime; _needsSave = true; }
      }
    } else if (!hasPriceVar && isGM) {
      // Variation off — clear any stale adjusted prices on active items.
      const items = isRandom ? (course.drawnItems ?? []) : (course.items ?? []);
      if (items.some(i => i.currentPrice)) { for (const i of items) delete i.currentPrice; _needsSave = true; }
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
        const resolvedPrice = item.currentPrice ?? item.price ?? course.price;
        let priceLabel = null;
        if (resolvedPrice) {
          priceLabel = resolvedPrice.coins
            ? formatAmounts(resolvedPrice.coins, currencies)
            : `${resolvedPrice.amount} ${(currencies.find(c => c.id === resolvedPrice.currencyId))?.abbreviation ?? "?"}`;
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
