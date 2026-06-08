import { MODULE_ID, SETTINGS, FLAGS } from "../constants.js";

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

/**
 * Grant a coins map { [currencyId]: amount } to an actor.
 * Grants each denomination directly without recalculating denominations.
 */
export async function grantCoinsToActor(actor, coins, currencies, mode) {
  for (const [currencyId, amount] of Object.entries(coins)) {
    if (!amount || amount <= 0) continue;
    const currency = currencies.find(c => c.id === currencyId);
    if (!currency) continue;
    if (mode === 'attribute' && currency.attributePath) {
      const current = foundry.utils.getProperty(actor, currency.attributePath) ?? 0;
      await actor.update({ [currency.attributePath]: current + amount });
    } else if (mode === 'item' && currency.itemName) {
      const existing = actor.items.find(i => i.name === currency.itemName);
      if (existing) {
        const qty = foundry.utils.getProperty(existing, 'system.quantity') ?? 0;
        await existing.update({ 'system.quantity': qty + amount });
      } else {
        const source = game.items.find(i => i.name === currency.itemName)
          ?? (currency.itemId ? await fromUuid(currency.itemId).catch(() => null) : null);
        if (source) {
          const data = source.toObject();
          foundry.utils.setProperty(data, 'system.quantity', amount);
          await actor.createEmbeddedDocuments('Item', [data]);
        }
      }
    }
  }
}

/**
 * Remove a coins map { [currencyId]: amount } from an actor.
 * Decrements each denomination directly.
 */
export async function removeCoinsFromActor(actor, coins, currencies, mode) {
  for (const [currencyId, amount] of Object.entries(coins)) {
    if (!amount || amount <= 0) continue;
    const currency = currencies.find(c => c.id === currencyId);
    if (!currency) continue;
    if (mode === 'attribute' && currency.attributePath) {
      const current = foundry.utils.getProperty(actor, currency.attributePath) ?? 0;
      await actor.update({ [currency.attributePath]: Math.max(0, current - amount) });
    } else if (mode === 'item' && currency.itemName) {
      const item = actor.items.find(i => i.name === currency.itemName);
      if (!item) continue;
      const qty = foundry.utils.getProperty(item, 'system.quantity') ?? 0;
      if (qty <= amount) await item.delete();
      else await item.update({ 'system.quantity': qty - amount });
    }
  }
}

/**
 * Read an actor's balance of a single currency, as a coin count.
 * Returns 0 in loose mode or when the currency has no configured path/item.
 */
export function readActorBalance(actor, currency, mode) {
  if (!actor || !currency) return 0;
  if (mode === "attribute" && currency.attributePath) {
    return foundry.utils.getProperty(actor, currency.attributePath) ?? 0;
  }
  if (mode === "item" && currency.itemName) {
    const item = actor.items.find(i => i.name === currency.itemName);
    return item ? (foundry.utils.getProperty(item, "system.quantity") ?? 0) : 0;
  }
  return 0;
}

/**
 * Break a standard-currency amount into coins (constrained to maxDenomValue) and grant them
 * to an actor. Falls back to ceil-ing in the smallest eligible denomination when exact change
 * is impossible. No-op in loose mode.
 */
export async function grantStandardToActor(actor, amountInStandard, currencies, mode, maxDenomValue = null) {
  if (!actor || amountInStandard < 1e-9 || mode === "loose") return;
  const effectiveMax = maxDenomValue ?? currencies.reduce((max, c) => Math.max(max, parseExchangeRate(c.exchangeRate)), 0);

  let coins = calculateChange(amountInStandard, currencies, effectiveMax);
  if (!coins) {
    const eligible = [...currencies]
      .filter(c => parseExchangeRate(c.exchangeRate) <= effectiveMax + 1e-9)
      .sort((a, b) => parseExchangeRate(a.exchangeRate) - parseExchangeRate(b.exchangeRate));
    const sc = eligible[0] ?? currencies.find(c => c.isStandard);
    if (!sc) return;
    coins = { [sc.id]: Math.ceil(amountInStandard / parseExchangeRate(sc.exchangeRate)) };
  }
  await grantCoinsToActor(actor, coins, currencies, mode);
}

/**
 * Atomically apply a purchase: remove `payment` coins and grant `change` coins.
 * Attribute mode batches both sides into a single actor.update. Item mode guards against
 * negative quantities and creates the source item when giving change for a coin the actor lacks.
 * Throws on insufficient funds (caller should pre-validate and catch).
 */
export async function settlePayment(actor, { payment = {}, change = {} }, currencies, mode) {
  if (!actor || mode === "loose") return;

  if (mode === "attribute") {
    const updates = {};
    const collect = (currencyId, delta) => {
      const c = currencies.find(x => x.id === currencyId);
      if (!c?.attributePath) return;
      const current = updates[c.attributePath] ?? foundry.utils.getProperty(actor, c.attributePath) ?? 0;
      updates[c.attributePath] = current + delta;
    };
    for (const [id, coins] of Object.entries(payment)) if (coins > 0) collect(id, -coins);
    for (const [id, coins] of Object.entries(change))  if (coins > 0) collect(id,  coins);
    if (Object.keys(updates).length) await actor.update(updates);
    return;
  }

  // item mode
  const applyDelta = async (currencyId, delta) => {
    const c = currencies.find(x => x.id === currencyId);
    if (!c) return;
    const existing = actor.items.find(i => i.name === c.itemName);
    if (existing) {
      const qty = foundry.utils.getProperty(existing, "system.quantity") ?? 0;
      if (delta < 0 && qty + delta < 0) {
        ui.notifications.warn(`${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.purchase.error.insufficientFunds")}: ${c.name}`);
        throw new Error("Insufficient item quantity");
      }
      await existing.update({ "system.quantity": qty + delta });
      return;
    }
    if (delta <= 0) return; // only relevant when giving change
    const source = game.items.find(i => i.name === c.itemName)
      ?? (c.itemId ? await fromUuid(c.itemId).catch(() => null) : null);
    if (source) {
      const data = source.toObject();
      foundry.utils.setProperty(data, "system.quantity", delta);
      await actor.createEmbeddedDocuments("Item", [data]);
    } else {
      ui.notifications.warn(`Cannot give change: no world item found for "${c.itemName}"`);
    }
  };
  for (const [id, coins] of Object.entries(payment)) if (coins > 0) await applyDelta(id, -coins);
  for (const [id, coins] of Object.entries(change))  if (coins > 0) await applyDelta(id,  coins);
}

/**
 * Returns the exchange rate (in standard units) of the highest denomination
 * a merchant in the current scene's settlement type can pay.
 * Falls back to the global max rate if no constraint is configured.
 */
export function getSettlementMaxDenomValue(currencies) {
  const settlementTypes    = game.settings.get(MODULE_ID, SETTINGS.SETTLEMENT_TYPES) ?? [];
  const settlementTypeName = canvas.scene?.getFlag(MODULE_ID, FLAGS.SETTLEMENT_TYPE) ?? "";
  const settlementType     = settlementTypes.find(t => t.name === settlementTypeName);
  const globalMax    = currencies.reduce((max, c) => Math.max(max, parseExchangeRate(c.exchangeRate)), 0);
  const maxId        = settlementType?.maxCurrencyId ?? "";
  if (maxId === "*") return globalMax;
  if (maxId === "") {
    // Default: cap at the standard (1:1) currency
    const std = currencies.find(c => c.isStandard);
    return std ? parseExchangeRate(std.exchangeRate) : globalMax;
  }
  const maxCurr = currencies.find(c => c.id === maxId);
  return maxCurr ? parseExchangeRate(maxCurr.exchangeRate) : globalMax;
}
