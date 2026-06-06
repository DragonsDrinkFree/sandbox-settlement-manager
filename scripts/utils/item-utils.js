import { MODULE_ID, SETTINGS } from '../constants.js';

/**
 * Read an item's price from a Foundry item document using the configured
 * attribute mapping (Item Settings). Returns { amount, currencyId } or null.
 *
 * Supports three price formats configured in SETTINGS.ITEM_CONFIG:
 *   "simple"              — single number at priceAttribute; standard currency assumed
 *   "denomination-field"  — number at priceAttribute + abbreviation at priceDenominationAttribute
 *   "denomination-object" — object at priceAttribute; keys are currency abbreviations
 */
export function readItemPrice(item, currencies) {
  const { priceFormat, priceAttribute, priceDenominationAttribute }
    = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);
  if (priceFormat === 'manual') return null;
  if (!priceAttribute) return null;

  const standardCurrency = currencies.find(c => c.isStandard) ?? currencies[0] ?? null;

  if (priceFormat === 'simple') {
    const amount = parseFloat(foundry.utils.getProperty(item, priceAttribute)) || 0;
    if (amount <= 0) return null;
    return { amount, currencyId: standardCurrency?.id ?? null };
  }

  if (priceFormat === 'denomination-field') {
    const amount = parseFloat(foundry.utils.getProperty(item, priceAttribute)) || 0;
    if (amount <= 0) return null;
    const abbr = priceDenominationAttribute
      ? foundry.utils.getProperty(item, priceDenominationAttribute)
      : null;
    const currency = (abbr
      ? currencies.find(c => c.abbreviation.toLowerCase() === String(abbr).toLowerCase())
      : null) ?? standardCurrency;
    return { amount, currencyId: currency?.id ?? null };
  }

  if (priceFormat === 'denomination-object') {
    const obj = foundry.utils.getProperty(item, priceAttribute);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    for (const [abbr, amt] of Object.entries(obj)) {
      const parsed = parseFloat(amt) || 0;
      if (parsed <= 0) continue;
      const currency = currencies.find(c => c.abbreviation.toLowerCase() === abbr.toLowerCase())
        ?? standardCurrency;
      return { amount: parsed, currencyId: currency?.id ?? null };
    }
    return null;
  }

  return null;
}

/** Read an item's display name using the configured nameAttribute. */
export function readItemName(item) {
  const { nameAttribute } = game.settings.get(MODULE_ID, SETTINGS.ITEM_CONFIG);
  const path = (nameAttribute ?? '').trim() || 'name';
  return String(foundry.utils.getProperty(item, path) ?? item.name ?? '');
}
