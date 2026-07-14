import {
  parseExchangeRate,
  calculateChange,
  getMaxDenomValue,
  getStandardCurrency,
  readActorBalance
} from "./currency-utils.js";

/**
 * Loan interest periods use fixed lengths independent of the world calendar's week/month:
 * a week is always 7 days and a month always 30 days (per the loan UI's explanatory label).
 * The day length itself still comes from the world config (hoursPerDay), passed in as secondsPerDay.
 */
export const LOAN_PERIOD_DAYS = { day: 1, week: 7, month: 30 };

/** Seconds in one interest period of the given unit. */
export function periodSecondsFor(unit, secondsPerDay) {
  return (LOAN_PERIOD_DAYS[unit] ?? 1) * secondsPerDay;
}

/**
 * Advance a loan's balance to `now` by applying discrete compound interest at each full period
 * boundary since `lastAccrualAt`. Interest is `balance *= (1 + rate/100)` per elapsed period,
 * always on the *current* balance — so partial payments shrink each period's charge while an
 * ignored loan compounds. Cadence is anchored at acceptance (`lastAccrualAt` advances by whole
 * periods only), never re-anchored by payments.
 *
 * Pure: returns a new loan object (or the same reference when nothing changed). Used both for
 * on-read display and for server-authoritative mutation before a balance change.
 */
export function accrueLoan(loan, now) {
  if (!loan || loan.status !== "active") return loan;
  const periodSeconds = loan.periodSeconds;
  if (!periodSeconds || periodSeconds <= 0) return loan;
  const elapsed = now - (loan.lastAccrualAt ?? now);
  const periods = Math.floor(elapsed / periodSeconds);
  if (periods <= 0) return loan;
  const factor = Math.pow(1 + (loan.interestRate ?? 0) / 100, periods);
  return {
    ...loan,
    balanceStandard: (loan.balanceStandard ?? 0) * factor,
    lastAccrualAt:   (loan.lastAccrualAt ?? now) + periods * periodSeconds
  };
}

/**
 * Break a standard-currency debt into a coin map that fully covers it, rounding *up* to the
 * smallest denomination so a rounded payment can never leave the loan short. Used for the
 * "amount owed" display and the "pay off in full" convenience.
 */
export function computeOwedCoins(balanceStandard, currencies) {
  if (!(balanceStandard > 1e-9) || !currencies.length) return {};
  const smallest = currencies.reduce((min, c) => {
    const r = parseExchangeRate(c.exchangeRate);
    return r < min ? r : min;
  }, Infinity);
  const rounded = (isFinite(smallest) && smallest > 0)
    ? Math.ceil(balanceStandard / smallest - 1e-9) * smallest
    : balanceStandard;
  const coins = calculateChange(rounded, currencies, getMaxDenomValue(currencies));
  if (coins) return coins;
  // Fallback: pile the whole debt into the smallest denomination.
  const sc = currencies.find(c => parseExchangeRate(c.exchangeRate) === smallest)
    ?? getStandardCurrency(currencies);
  if (!sc) return {};
  return { [sc.id]: Math.ceil(rounded / parseExchangeRate(sc.exchangeRate) - 1e-9) };
}

/**
 * Abbreviations of the currencies the actor cannot cover for the given coin map. Empty in loose
 * mode (no balances are tracked) or when the actor holds enough of every denomination.
 */
export function insufficientCurrencies(actor, coins, currencies, mode) {
  if (mode === "loose" || !actor) return [];
  const short = [];
  for (const [cId, amt] of Object.entries(coins ?? {})) {
    if (!(amt > 0)) continue;
    const c = currencies.find(x => x.id === cId);
    if (!c) continue;
    if (readActorBalance(actor, c, mode) < amt) short.push(c.abbreviation);
  }
  return short;
}

/**
 * Choose coins from the actor's actual holdings to cover `owedStandard`, preferring larger
 * denominations and topping up with the smallest available coin when a denomination can't be made
 * exactly (the excess comes back as change). In loose mode there are no balances, so it returns the
 * exact owed breakdown. Returns { coins, shortfall } — shortfall > 0 means the actor can't cover it.
 */
export function selectPayoffCoins(actor, owedStandard, currencies, mode) {
  if (mode === "loose" || !actor) return { coins: computeOwedCoins(owedStandard, currencies), shortfall: 0 };
  const coins = {};
  let remaining = owedStandard;
  const byDenomDesc = [...currencies].sort((a, b) => parseExchangeRate(b.exchangeRate) - parseExchangeRate(a.exchangeRate));

  // Pass 1: take large denominations without overshooting.
  for (const c of byDenomDesc) {
    if (remaining <= 1e-9) break;
    const rate = parseExchangeRate(c.exchangeRate);
    if (rate <= 0) continue;
    const take = Math.min(readActorBalance(actor, c, mode), Math.floor(remaining / rate + 1e-9));
    if (take > 0) { coins[c.id] = take; remaining -= take * rate; }
  }
  // Pass 2: cover the remainder with the smallest available coins (may overshoot → change).
  if (remaining > 1e-9) {
    for (const c of [...byDenomDesc].reverse()) {
      if (remaining <= 1e-9) break;
      const rate = parseExchangeRate(c.exchangeRate);
      if (rate <= 0) continue;
      const held  = coins[c.id] ?? 0;
      const avail = readActorBalance(actor, c, mode) - held;
      if (avail <= 0) continue;
      const add = Math.min(avail, Math.ceil(remaining / rate - 1e-9));
      if (add > 0) { coins[c.id] = held + add; remaining -= add * rate; }
    }
  }
  return { coins, shortfall: Math.max(0, remaining) };
}
