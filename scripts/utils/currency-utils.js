/**
 * Exchange rate "A:B" means A standard currency = B of this currency.
 * Returns A/B — the value of one coin of this currency in standard units.
 */
export function parseExchangeRate(rateStr) {
  if (!rateStr || typeof rateStr !== "string") return 1;
  const parts = rateStr.split(":");
  if (parts.length !== 2) return 1;
  const a = parseFloat(parts[0]);
  const b = parseFloat(parts[1]);
  if (isNaN(a) || isNaN(b) || b === 0) return 1;
  return a / b;
}

/**
 * Convert an expense's cost to standard currency.
 */
export function costInStandard(expense, currencies) {
  const c = currencies.find(x => x.id === expense.currencyId);
  if (!c) return 0;
  return expense.amount * parseExchangeRate(c.exchangeRate);
}

/**
 * Sum all payment coin-counts into standard currency.
 * @param {{ [currencyId]: number }} paymentAmounts
 */
export function totalOfferedInStandard(paymentAmounts, currencies) {
  return currencies.reduce((sum, c) => {
    const coins = paymentAmounts[c.id] ?? 0;
    return sum + coins * parseExchangeRate(c.exchangeRate);
  }, 0);
}

/**
 * Break excessStandard into coins using greedy algorithm.
 * Only uses denominations whose rate ≤ maxDenomValue.
 * Returns { [currencyId]: coinCount } or null if change cannot be made exactly.
 */
export function calculateChange(excessStandard, currencies, maxDenomValue) {
  const EPSILON = 1e-9;
  if (excessStandard < EPSILON) return {};

  const eligible = currencies
    .filter(c => parseExchangeRate(c.exchangeRate) <= maxDenomValue + EPSILON)
    .sort((a, b) => parseExchangeRate(b.exchangeRate) - parseExchangeRate(a.exchangeRate));

  const change = {};
  let remaining = excessStandard;

  for (const c of eligible) {
    const rate = parseExchangeRate(c.exchangeRate);
    const coins = Math.floor(remaining / rate + EPSILON);
    if (coins > 0) {
      change[c.id] = coins;
      remaining -= coins * rate;
    }
  }

  if (remaining > EPSILON) return null; // cannot make exact change
  return change;
}

/**
 * Format a coin-count map to a human-readable string.
 * Respects currency order from the currencies array.
 */
export function formatAmounts(amounts, currencies) {
  const parts = currencies
    .filter(c => (amounts[c.id] ?? 0) > 0)
    .map(c => `${amounts[c.id]} ${c.abbreviation}`);
  if (!parts.length) {
    const std = currencies.find(c => c.isStandard);
    return `0 ${std?.abbreviation ?? ""}`;
  }
  return parts.join(", ");
}
