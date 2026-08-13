import { MODULE_ID, FLAGS, SETTINGS } from "./constants.js";
import { grantCoinsToActor, grantStandardToActor, parseExchangeRate, totalOfferedInStandard, getMaxDenomValue, costInStandard } from "./utils/currency-utils.js";
import { accrueLoan, periodSecondsFor } from "./utils/loan-utils.js";
import { accrueStorageRent, resolveRentalPricing, availablePeriodUnits } from "./utils/rental-utils.js";
import { resolveInstanceStorageType, nextFreeAreaName } from "./utils/storage-utils.js";
import { getWorldTimeConfig } from "./time/world-time.js";

export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const SOCKET_TYPES = {
  SAVE_LOCATION:          "saveLocation",
  RECORD_DEPOSIT:         "recordDeposit",
  PROCESS_WITHDRAWAL:     "processWithdrawal",
  RECORD_LEDGER_ENTRIES:  "recordLedgerEntries",
  ACCEPT_LOAN:            "acceptLoan",
  DECLINE_LOAN:           "declineLoan",
  REPAY_LOAN:             "repayLoan",
  RENT_STORAGE:           "rentStorage",
  EXTEND_STORAGE_RENTAL:  "extendStorageRental",
  PAY_STORAGE_RENT:       "payStorageRent"
};

export function registerSocketHandlers() {
  game.socket.on(SOCKET_CHANNEL, async (data) => {
    if (!data?.type) return;

    // Player → GM messages: only the active GM processes each message once.
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;

    if (data.type === SOCKET_TYPES.SAVE_LOCATION) {
      await _handleSaveLocation(data);
    } else if (data.type === SOCKET_TYPES.RECORD_DEPOSIT) {
      // Bank actions wrap their fields under `payload`; unwrap before handling.
      await _handleRecordDeposit(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.PROCESS_WITHDRAWAL) {
      await _handleProcessWithdrawal(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.RECORD_LEDGER_ENTRIES) {
      await _handleRecordLedgerEntries(data);
    } else if (data.type === SOCKET_TYPES.ACCEPT_LOAN) {
      await _handleAcceptLoan(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.DECLINE_LOAN) {
      await _handleDeclineLoan(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.REPAY_LOAN) {
      await _handleRepayLoan(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.RENT_STORAGE) {
      await _handleRentStorage(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.EXTEND_STORAGE_RENTAL) {
      await _handleExtendStorageRental(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.PAY_STORAGE_RENT) {
      await _handlePayStorageRent(data.payload ?? data);
    } else {
      console.warn(`${MODULE_ID} | Unknown socket message type: ${data.type}`);
    }
  });
}

/**
 * True when the given user owns the given actor. Used to reject bank socket
 * messages that target an actor the requesting player does not control.
 */
function _userOwnsActor(userId, actorId) {
  const user  = game.users.get(userId);
  const actor = game.actors.get(actorId);
  if (!user || !actor) return false;
  return actor.testUserPermission(user, "OWNER");
}

/**
 * GM-side handler: replaces a single location in the scene flag by ID.
 * Players cannot write scene flags directly, so all location mutations from
 * non-GM clients are routed here via socket.
 */
async function _handleSaveLocation({ sceneId, location }) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const locations = scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
  const index = locations.findIndex(r => r.id === location.id);
  if (index === -1) return;
  locations[index] = location;
  await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
}

/** GM-side: record a new deposit into either world setting (global) or scene flag. */
export async function _handleRecordDeposit({ deposit, locationId, entryId, sceneId, isGlobal, userId }) {
  if (!_userOwnsActor(userId, deposit?.actorId)) return;
  if (isGlobal) {
    const existing = game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [];
    await game.settings.set(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS, [...existing, deposit]);
  } else {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
    const location  = locations.find(r => r.id === locationId);
    if (!location?.typeData?.[entryId]) return;
    location.typeData[entryId].deposits = [...(location.typeData[entryId].deposits ?? []), deposit];
    await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  }
  _refreshBankApps();
}

/**
 * GM-side: process a withdrawal.
 * Deducts withdrawCoins from the deposit records, consolidates matured deposits,
 * then grants the payout (minus early fee) to the actor.
 */
export async function _handleProcessWithdrawal({
  depositIds, withdrawCoins, actorId, earlyFeeRate,
  locationId, entryId, sceneId, isGlobal, userId
}) {
  if (!_userOwnsActor(userId, actorId)) return;
  const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG) ?? { currencies: [] };
  const currencies     = currencyConfig.currencies ?? [];
  const mode           = currencyConfig.mode ?? 'loose';
  const actor          = game.actors.get(actorId);
  if (!actor) return;

  // Load current deposits
  let allDeposits;
  let scene, locations, location;
  if (isGlobal) {
    allDeposits = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? []);
  } else {
    scene     = game.scenes.get(sceneId);
    if (!scene) return;
    locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
    location  = locations.find(r => r.id === locationId);
    allDeposits = foundry.utils.deepClone(location?.typeData?.[entryId]?.deposits ?? []);
  }

  // The client sends the bank's *configured* early-withdrawal rate regardless of whether this
  // particular deposit has actually matured; only trust it (and only re-denominate the payout
  // below) if at least one targeted deposit genuinely hasn't matured yet.
  const targetIds = new Set(depositIds);
  const now = game.time.worldTime;
  const isEarly = allDeposits.some(d => targetIds.has(d.id) && now < d.depositedAt + d.minDepositSeconds);
  const effectiveFeeRate = isEarly ? earlyFeeRate : 0;

  // Deduct withdrawCoins from the matched deposit records, treated as a shared pool: each
  // currency's withdrawn total comes out of the group as a whole (draining one record before
  // moving to the next), not from every matched record independently — otherwise a partial
  // withdrawal from a merged/matured group would wipe out every record's balance, destroying
  // whatever wasn't withdrawn.
  // `deductedCoins` records what the records could *actually* cover. The client's requested
  // amounts are never paid out directly — a request exceeding the stored balance would otherwise
  // drain the deposits and still grant the full request, minting currency from nothing.
  const matchedDeposits = allDeposits.filter(d => targetIds.has(d.id));
  const deductedCoins = {};
  for (const [cId, rawAmt] of Object.entries(withdrawCoins)) {
    const amt = Math.max(0, Math.floor(Number(rawAmt) || 0));
    let remaining = amt;
    for (const dep of matchedDeposits) {
      if (remaining <= 0) break;
      const available = dep.coins[cId] ?? 0;
      const take = Math.min(available, remaining);
      if (take <= 0) continue;
      dep.coins[cId] = available - take;
      if (dep.coins[cId] <= 0) delete dep.coins[cId];
      remaining -= take;
      deductedCoins[cId] = (deductedCoins[cId] ?? 0) + take;
    }
  }
  // Remove fully emptied deposits
  const trimmed = allDeposits.filter(d => Object.keys(d.coins).length > 0);

  // Consolidate matured deposits for this actor
  const consolidated = _consolidateMatureDeposits(trimmed, actorId);

  // Save back
  if (isGlobal) {
    await game.settings.set(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS, consolidated);
  } else if (location?.typeData?.[entryId]) {
    location.typeData[entryId].deposits = consolidated;
    await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  }

  // Compute payout from what was actually deducted, minus the proportional early fee (only when
  // genuinely early — see effectiveFeeRate above). When no fee applies, the payout is exactly the
  // coins that came out of the records.
  if (mode !== 'loose') {
    if (effectiveFeeRate > 0) {
      const totalStd  = totalOfferedInStandard(deductedCoins, currencies);
      const feeStd    = totalStd * effectiveFeeRate / 100;
      const payoutStd = Math.max(0, totalStd - feeStd);
      // Cap re-denomination to the highest-value coin actually withdrawn, so a fee can never turn
      // the payout into a larger/unrelated denomination (e.g. GP becoming PP) the player never handled.
      const withdrawnRates = Object.keys(deductedCoins)
        .map(cId => parseExchangeRate(currencies.find(c => c.id === cId)?.exchangeRate));
      const maxDenom = withdrawnRates.length ? Math.max(...withdrawnRates) : getMaxDenomValue(currencies);
      // grantStandardToActor falls back to the smallest eligible denomination when exact change
      // can't be made — paying out nothing here would destroy the deposit, which was already
      // reduced and saved above.
      await grantStandardToActor(actor, payoutStd, currencies, mode, maxDenom);
    } else {
      await grantCoinsToActor(actor, deductedCoins, currencies, mode);
    }
  }

  _refreshBankApps();
}

/**
 * GM-only: apply an edit to one or more deposit records (as displayed via a possibly-merged row).
 * Removes every deposit whose id is in `targetIds` and appends the single `updatedDeposit` in its
 * place, consolidating merged/matured records into one. Called directly from the GM-gated edit
 * dialog — never routed through the socket dispatcher, so no actor-ownership check is needed here
 * (unlike _handleRecordDeposit/_handleProcessWithdrawal, which do get called via player sockets).
 */
export async function _handleEditDeposit({ targetIds, updatedDeposit, locationId, entryId, sceneId, isGlobal }) {
  const targetSet = new Set(targetIds);
  if (isGlobal) {
    const existing = game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [];
    const kept = existing.filter(d => !targetSet.has(d.id));
    await game.settings.set(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS, [...kept, updatedDeposit]);
  } else {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
    const location  = locations.find(r => r.id === locationId);
    if (!location?.typeData?.[entryId]) return;
    const existing = location.typeData[entryId].deposits ?? [];
    location.typeData[entryId].deposits = [...existing.filter(d => !targetSet.has(d.id)), updatedDeposit];
    await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  }
  _refreshBankApps();
}

/**
 * Load the bank entry + its loans array from a scene flag, returning the mutable deepClone chain
 * so the caller can mutate and persist with a single setFlag. Returns null if anything is missing.
 */
function _loadBankLoans(sceneId, locationId, entryId) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return null;
  const locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
  const location  = locations.find(r => r.id === locationId);
  const bank      = location?.typeData?.[entryId];
  if (!bank) return null;
  bank.loans = bank.loans ?? [];
  return { scene, locations, bank };
}

/**
 * GM-side: a player accepts a pending loan offer. Flips the loan to active (interest accrual
 * begins now) and hands the principal over as an immediately-matured deposit, honoring the bank's
 * global-vs-local deposit setting.
 */
export async function _handleAcceptLoan({ loanId, locationId, entryId, sceneId, userId }) {
  const ctx = _loadBankLoans(sceneId, locationId, entryId);
  if (!ctx) return;
  const { scene, locations, bank } = ctx;
  const loan = bank.loans.find(l => l.id === loanId);
  if (!loan || loan.status !== "offered") return;
  if (!_userOwnsActor(userId, loan.actorId)) return;

  const now = game.time.worldTime;
  loan.status          = "active";
  loan.acceptedAt      = now;
  loan.lastAccrualAt   = now;
  loan.balanceStandard = loan.principalStandard;

  const deposit = {
    id:                foundry.utils.randomID(),
    actorId:           loan.actorId,
    actorName:         loan.actorName,
    coins:             { ...loan.principalCoins },
    depositedAt:       now,
    minDepositSeconds: 0
  };

  const isGlobal = bank.depositSettings?.global ?? false;
  if (isGlobal) {
    const existing = game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [];
    await game.settings.set(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS, [...existing, deposit]);
  } else {
    bank.deposits = [...(bank.deposits ?? []), deposit];
  }
  await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  _refreshBankApps();
}

/** GM-side: a player declines a pending loan offer, removing it. */
export async function _handleDeclineLoan({ loanId, locationId, entryId, sceneId, userId }) {
  const ctx = _loadBankLoans(sceneId, locationId, entryId);
  if (!ctx) return;
  const { scene, locations, bank } = ctx;
  const loan = bank.loans.find(l => l.id === loanId);
  if (!loan || loan.status !== "offered") return;
  if (!_userOwnsActor(userId, loan.actorId)) return;

  bank.loans = bank.loans.filter(l => l.id !== loanId);
  await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  _refreshBankApps();
}

/**
 * GM-side: a player makes a payment against an active loan. The actor was already debited the
 * paid coins client-side; here we accrue interest to now (server-authoritative), subtract the
 * payment, and either persist the reduced loan or — when paid off — remove it and refund any
 * overpayment.
 */
export async function _handleRepayLoan({ loanId, payCoins, locationId, entryId, sceneId, userId }) {
  const ctx = _loadBankLoans(sceneId, locationId, entryId);
  if (!ctx) return;
  const { scene, locations, bank } = ctx;
  const idx = bank.loans.findIndex(l => l.id === loanId);
  if (idx === -1) return;
  const loan = bank.loans[idx];
  if (loan.status !== "active") return;
  if (!_userOwnsActor(userId, loan.actorId)) return;

  const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG) ?? { currencies: [] };
  const currencies     = currencyConfig.currencies ?? [];
  const mode           = currencyConfig.mode ?? 'loose';
  const now            = game.time.worldTime;

  const accrued     = accrueLoan(loan, now);
  const payStandard = totalOfferedInStandard(payCoins ?? {}, currencies);
  const newBalance  = accrued.balanceStandard - payStandard;

  if (newBalance <= 1e-6) {
    bank.loans.splice(idx, 1); // paid off
    const overpay = -newBalance;
    if (overpay > 1e-6 && mode !== 'loose') {
      const actor = game.actors.get(loan.actorId);
      if (actor) {
        // Cap change to the highest denomination actually paid, so overpaying with small coins can
        // never hand back a larger/unrelated denomination the player never tendered.
        const paidRates = Object.keys(payCoins ?? {}).map(cId => parseExchangeRate(currencies.find(c => c.id === cId)?.exchangeRate));
        const maxDenom  = paidRates.length ? Math.max(...paidRates) : getMaxDenomValue(currencies);
        await grantStandardToActor(actor, overpay, currencies, mode, maxDenom);
      }
    }
  } else {
    bank.loans[idx] = { ...accrued, balanceStandard: newBalance };
  }
  await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  _refreshBankApps();
}

/**
 * Load a location fresh (deepClone) from its scene flag by id. Returns { scene, locations,
 * location } or null if anything is missing. Shared by the three storage-rental handlers below.
 */
function _loadLocation(sceneId, locationId) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return null;
  const locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
  const location  = locations.find(r => r.id === locationId);
  if (!location) return null;
  return { scene, locations, location };
}

/**
 * GM-side: a player rents a Storage Area from a Bank's linked Storage entry. Re-resolves the
 * chosen storageRentalOptions row server-side (never trusts client-provided pricing), creates the
 * Storage Group with the renter as Primary access, and records the rental paid through `periods`
 * periods from now. Mirrors createNewLodgingBooking's group-creation shape in lodging-fulfillment.js.
 */
export async function _handleRentStorage({ optionId, periodUnit, periods, actorId, actorName, areaName, locationId, entryId, sceneId, userId }) {
  if (!_userOwnsActor(userId, actorId)) return;
  const ctx = _loadLocation(sceneId, locationId);
  if (!ctx) return;
  const { scene, locations, location } = ctx;
  const bank = location.typeData?.[entryId];
  if (!bank || !bank.linkedStorageEntryId) return;
  const option = (bank.storageRentalOptions ?? []).find(o => o.id === optionId);
  if (!option || !(periods > 0)) return;
  const storageData = location.typeData?.[bank.linkedStorageEntryId];
  if (!storageData) return;
  // option.storageTypeId is a *template* Storage Type id (the only kind available when the Storage
  // Rental Option was configured) — translate it to this Location's instance Storage Type.
  const instanceStorageType = resolveInstanceStorageType(storageData.storageTypes, option.storageTypeId);
  if (!instanceStorageType) return;

  // Re-resolve pricing server-side rather than trusting the client's chosen rate, and reject any
  // period shorter than this option's configured minimum.
  const pricing = resolveRentalPricing(option);
  if (!availablePeriodUnits(pricing.minPeriodUnit).includes(periodUnit)) return;
  const rate = pricing[periodUnit];

  const now = game.time.worldTime;
  const { hoursPerDay } = getWorldTimeConfig();
  const periodSeconds = periodSecondsFor(periodUnit, hoursPerDay * 3600);

  const group = {
    id: foundry.utils.randomID(),
    // Recomputed server-side rather than trusting the client's default, so a name is never
    // duplicated by two players renting at once.
    name: (areaName ?? "").trim() || nextFreeAreaName(option.namingTemplate, storageData.groups),
    storageTypeId: instanceStorageType.id,
    access: [{ actorId, level: "primary" }],
    retrievalPolicyOverride: null
  };
  storageData.groups = [...(storageData.groups ?? []), group];

  bank.rentals = [...(bank.rentals ?? []), {
    id: foundry.utils.randomID(),
    actorId, actorName,
    groupId: group.id,
    storageTypeId: instanceStorageType.id,
    // The rental snapshots the single rate it was signed at, so later price edits never change
    // what an in-flight renter owes — and accrual/extend/pay-off need no per-tier awareness.
    feeAmount: rate.amount,
    feeCurrencyId: rate.currencyId,
    periodUnit,
    periodSeconds,
    paidThroughAt: now + periods * periodSeconds,
    status: "active",
    owedStandard: 0,
    lastAccrualAt: null,
    createdAt: now
  }];

  await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  _refreshBankApps();
}

/** GM-side: a player prepays additional periods on an active (not delinquent) storage rental. */
export async function _handleExtendStorageRental({ rentalId, periods, locationId, entryId, sceneId, userId }) {
  const ctx = _loadLocation(sceneId, locationId);
  if (!ctx) return;
  const { scene, locations, location } = ctx;
  const bank = location.typeData?.[entryId];
  const rental = bank?.rentals?.find(r => r.id === rentalId);
  if (!rental || rental.status !== "active" || !(periods > 0)) return;
  if (!_userOwnsActor(userId, rental.actorId)) return;

  const now  = game.time.worldTime;
  const base = Math.max(rental.paidThroughAt ?? now, now);
  rental.paidThroughAt = base + periods * rental.periodSeconds;

  await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  _refreshBankApps();
}

/**
 * GM-side: a player pays against a delinquent storage rental's owed balance. The actor was already
 * debited the paid coins client-side; here we accrue to now (server-authoritative), subtract the
 * payment, and — once the debt is cleared — flip the rental back to active, re-grant the renter's
 * access to the Storage Area, and refund any overpayment (same capped-denomination handling as
 * _handleRepayLoan).
 */
export async function _handlePayStorageRent({ rentalId, payCoins, locationId, entryId, sceneId, userId }) {
  const ctx = _loadLocation(sceneId, locationId);
  if (!ctx) return;
  const { scene, locations, location } = ctx;
  const bank = location.typeData?.[entryId];
  const idx  = bank?.rentals?.findIndex(r => r.id === rentalId) ?? -1;
  if (idx === -1) return;
  const rental = bank.rentals[idx];
  if (rental.status !== "delinquent") return;
  if (!_userOwnsActor(userId, rental.actorId)) return;

  const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG) ?? { currencies: [] };
  const currencies     = currencyConfig.currencies ?? [];
  const mode           = currencyConfig.mode ?? 'loose';
  const now            = game.time.worldTime;

  const feeStandard = costInStandard({ currencyId: rental.feeCurrencyId, amount: rental.feeAmount }, currencies);
  const accrued      = accrueStorageRent(rental, now, feeStandard);
  const payStandard   = totalOfferedInStandard(payCoins ?? {}, currencies);
  const newOwed       = (accrued.owedStandard ?? 0) - payStandard;

  if (newOwed <= 1e-6) {
    const storageData = location.typeData?.[bank.linkedStorageEntryId];
    const group = storageData?.groups?.find(g => g.id === rental.groupId);
    if (group && !(group.access ?? []).some(a => a.actorId === rental.actorId)) {
      group.access = [...(group.access ?? []), { actorId: rental.actorId, level: "primary" }];
    }
    const overpay = -newOwed;
    if (overpay > 1e-6 && mode !== 'loose') {
      const actor = game.actors.get(rental.actorId);
      if (actor) {
        const paidRates = Object.keys(payCoins ?? {}).map(cId => parseExchangeRate(currencies.find(c => c.id === cId)?.exchangeRate));
        const maxDenom  = paidRates.length ? Math.max(...paidRates) : getMaxDenomValue(currencies);
        await grantStandardToActor(actor, overpay, currencies, mode, maxDenom);
      }
    }
    // Rent is prepaid: clearing the debt buys back the period(s) it represented, extending the
    // original schedule (accrued.paidThroughAt, never mutated by accrual) rather than resetting
    // the clock to "now" — otherwise the very next sweep would immediately re-flip to delinquent.
    const periodsCovered  = feeStandard > 1e-9 ? Math.max(1, Math.round(accrued.owedStandard / feeStandard)) : 1;
    const newPaidThroughAt = (accrued.paidThroughAt ?? now) + periodsCovered * accrued.periodSeconds;
    bank.rentals[idx] = { ...accrued, status: "active", owedStandard: 0, lastAccrualAt: null, paidThroughAt: newPaidThroughAt };
  } else {
    bank.rentals[idx] = { ...accrued, owedStandard: newOwed };
  }

  await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  _refreshBankApps();
}

/** GM-side: append ledger entries to the scene flag. */
async function _handleRecordLedgerEntries({ sceneId, entries }) {
  const scene = game.scenes.get(sceneId);
  if (!scene || !entries?.length) return;
  const existing = scene.getFlag(MODULE_ID, FLAGS.LEDGER) ?? [];
  await scene.setFlag(MODULE_ID, FLAGS.LEDGER, [...existing, ...entries]);
}

/** Consolidate multiple matured deposits for each actor into one record. */
export function _consolidateMatureDeposits(deposits, filterActorId = null) {
  const now    = game.time.worldTime;
  const byActor = new Map();

  for (const dep of deposits) {
    if (!byActor.has(dep.actorId)) byActor.set(dep.actorId, { matured: [], unmatured: [] });
    const bucket = byActor.get(dep.actorId);
    if (now >= dep.depositedAt + dep.minDepositSeconds) bucket.matured.push(dep);
    else bucket.unmatured.push(dep);
  }

  const result = [];
  for (const [actorId, { matured, unmatured }] of byActor) {
    if (filterActorId && actorId !== filterActorId) {
      result.push(...matured, ...unmatured);
      continue;
    }
    if (matured.length > 1) {
      const merged = { ...matured[0], coins: {}, minDepositSeconds: 0 };
      for (const d of matured) {
        for (const [cId, amt] of Object.entries(d.coins)) {
          merged.coins[cId] = (merged.coins[cId] ?? 0) + amt;
        }
      }
      result.push(merged, ...unmatured);
    } else {
      result.push(...matured, ...unmatured);
    }
  }
  return result;
}

/** Re-render any open bank location windows so balances stay current. */
function _refreshBankApps() {
  for (const app of foundry.applications.instances.values()) {
    if (app.id === 'sandbox-settlement-manager-location-detail') app.render();
    else if (app.id === 'sandbox-settlement-manager-settlement-manage') app.render({ parts: ['content'] });
  }
}
