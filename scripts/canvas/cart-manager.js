import { getWorldTimeConfig } from '../time/world-time.js';
import { costInStandard, parseExchangeRate } from '../utils/currency-utils.js';

export const CART_HOOK = 'sandboxSettlementManagerCartUpdated';

class CartManager {
  #items = [];

  get items() { return foundry.utils.deepClone(this.#items); }

  /** Add a lodging to the cart. Multiple entries for the same lodging are allowed (separate bookings). */
  addLodging({ sceneId, locationId, locationName, entryId, lodging }) {
    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'lodging',
      sceneId,
      locationId,
      locationName,
      entryId: entryId ?? null,
      lodgingId: lodging.id,
      lodgingName: lodging.name,
      beds: lodging.beds ?? 1,
      pricePerDay:  lodging.currentPricePerDay  ?? lodging.pricePerDay  ?? null,
      pricePerWeek: lodging.currentPricePerWeek ?? lodging.pricePerWeek ?? null,
      duration: 1,
      unit: 'days'
    });
    this.#notify();
  }

  /**
   * Add a merchant inventory item to the cart. Stock-limited items (numeric quantity) are merged
   * into a single line and capped at available stock; null quantity means unlimited (∞).
   */
  addMerchantItem({ sceneId, locationId, locationName, entryId, item }) {
    const maxStock = typeof item.quantity === 'number' ? item.quantity : null;

    if (maxStock === 0) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.cart.outOfStock"));
      return;
    }

    const existing = this.#items.find(i =>
      i.type === 'merchantItem' &&
      i.sceneId === sceneId && i.locationId === locationId &&
      (i.entryId ?? null) === (entryId ?? null) && i.inventoryItemId === item.id
    );
    if (existing) {
      if (maxStock !== null && existing.quantity >= maxStock) {
        ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.cart.stockCapReached"));
        return;
      }
      existing.quantity = maxStock !== null ? Math.min(existing.quantity + 1, maxStock) : existing.quantity + 1;
      existing.maxStock = maxStock;
      this.#notify();
      return;
    }

    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'merchantItem',
      sceneId,
      locationId,
      locationName,
      entryId: entryId ?? null,
      inventoryItemId: item.id,
      itemName: item.name,
      itemLinkedId: item.itemId ?? null,
      price: item.currentPrice ?? item.price ?? null,
      quantity: 1,
      maxStock
    });
    this.#notify();
  }

  /**
   * Add a Stable listing to the cart. Stable listings now carry real stock like Merchant items
   * (see rollStockAvailability), so this mirrors addMerchantItem's stock cap / merge-into-existing-
   * line logic exactly — quantity > 1 buys that many independent copies on checkout.
   */
  addStableAnimal({ sceneId, locationId, locationName, entryId, listing }) {
    const maxStock = typeof listing.quantity === 'number' ? listing.quantity : null;

    if (maxStock === 0) {
      ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.cart.outOfStock"));
      return;
    }

    const existing = this.#items.find(i =>
      i.type === 'stableAnimal' &&
      i.sceneId === sceneId && i.locationId === locationId &&
      (i.entryId ?? null) === (entryId ?? null) && i.listingId === listing.id
    );
    if (existing) {
      if (maxStock !== null && existing.quantity >= maxStock) {
        ui.notifications.warn(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.cart.stockCapReached"));
        return;
      }
      existing.quantity = maxStock !== null ? Math.min(existing.quantity + 1, maxStock) : existing.quantity + 1;
      existing.maxStock = maxStock;
      this.#notify();
      return;
    }

    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'stableAnimal',
      sceneId,
      locationId,
      locationName,
      entryId: entryId ?? null,
      listingId: listing.id,
      actorUuid: listing.actorUuid,
      itemName: listing.name,
      price: listing.price,
      quantity: 1,
      maxStock
    });
    this.#notify();
  }

  /** Add an item being sold by the player to the cart. */
  addSellItem({ sceneId, locationId, locationName, actorId, actorName, actorItemId, itemName, itemLinkedUuid, salePrice }) {
    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'sellItem',
      sceneId,
      locationId,
      locationName,
      actorId,
      actorName,
      actorItemId,
      itemName,
      itemLinkedUuid: itemLinkedUuid ?? null,
      salePrice,
      quantity: 1
    });
    this.#notify();
  }

  /** Add a menu item to the cart. Price is resolved from item first, then course default. */
  addMenuItem({ sceneId, locationId, locationName, course, item }) {
    const resolvedPrice = item.currentPrice ?? item.price ?? course.price ?? null;
    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'menuItem',
      sceneId,
      locationId,
      locationName,
      courseId: course.id,
      itemId: item.id,
      itemName: item.name,
      itemLinkedId: item.itemId ?? null,
      price: resolvedPrice,
      quantity: 1
    });
    this.#notify();
  }

  /** Add a currency exchange transaction to the cart. Line total = fee only. */
  addExchange({ sceneId, locationId, locationName, actorId, actorName, fromCurrencyId, fromAmount, toCurrencyId, feeRatePercent }) {
    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'exchange',
      sceneId,
      locationId,
      locationName,
      actorId,
      actorName,
      fromCurrencyId,
      fromAmount,
      toCurrencyId,
      feeRatePercent
    });
    this.#notify();
  }

  updateItem(cartId, updates) {
    const item = this.#items.find(i => i.id === cartId);
    if (!item) return;
    Object.assign(item, updates);
    // Clamp stock-limited merchant/stable items to their available stock.
    if ((item.type === 'merchantItem' || item.type === 'stableAnimal') && typeof item.maxStock === 'number') {
      item.quantity = Math.max(1, Math.min(item.quantity, item.maxStock));
    }
    this.#notify();
  }

  removeItem(cartId) {
    this.#items = this.#items.filter(i => i.id !== cartId);
    this.#notify();
  }

  clear() {
    this.#items = [];
    this.#notify();
  }

  /** Returns { amount, currencyId } for this cart item, or null if no price is set. */
  computeLineTotal(item, currencies) {
    if (item.type === 'lodging') {
      // No Math.round: a price-varied lodging amount may be fractional in its base denomination (its
      // exact value is in the coin breakdown). Whole authored prices are unaffected.
      const { daysPerWeek } = getWorldTimeConfig();
      if (item.unit === 'weeks') {
        if (item.pricePerWeek) {
          return { amount: item.pricePerWeek.amount * item.duration, currencyId: item.pricePerWeek.currencyId };
        }
        if (item.pricePerDay) {
          return { amount: item.pricePerDay.amount * daysPerWeek * item.duration, currencyId: item.pricePerDay.currencyId };
        }
        return null;
      } else {
        if (item.pricePerDay) {
          return { amount: item.pricePerDay.amount * item.duration, currencyId: item.pricePerDay.currencyId };
        }
        return null;
      }
    }
    if (item.type === 'menuItem' || item.type === 'merchantItem' || item.type === 'stableAnimal') {
      if (!item.price) return null;
      // No Math.round: a price-varied merchant item's `amount` may be fractional in its base
      // denomination (its exact value lives in the coin breakdown); rounding here would drop it.
      // Whole authored/menu prices are unaffected.
      return { amount: item.price.amount * item.quantity, currencyId: item.price.currencyId };
    }
    if (item.type === 'sellItem') {
      if (!item.salePrice) return null;
      return { amount: Math.round(item.salePrice.amount * item.quantity), currencyId: item.salePrice.currencyId };
    }
    if (item.type === 'exchange') {
      const fromCurrency     = currencies.find(c => c.id === item.fromCurrencyId);
      const standardCurrency = currencies.find(c => c.isStandard);
      if (!fromCurrency || !standardCurrency || !item.feeRatePercent) return null;
      const fromStandard = item.fromAmount * parseExchangeRate(fromCurrency.exchangeRate);
      const feeStandard  = fromStandard * item.feeRatePercent / 100;
      if (feeStandard < 1e-9) return null;
      return { amount: feeStandard, currencyId: standardCurrency.id };
    }
    return null;
  }

  /** Sum purchase-side items only (excludes sellItems). */
  computePurchaseTotalInStandard(currencies) {
    let total = 0;
    for (const item of this.#items) {
      if (item.type === 'sellItem') continue;
      const lineTotal = this.computeLineTotal(item, currencies);
      if (!lineTotal) continue;
      total += costInStandard(lineTotal, currencies);
    }
    return total;
  }

  /** Sum sell-side items only. */
  computeSellTotalInStandard(currencies) {
    let total = 0;
    for (const item of this.#items) {
      if (item.type !== 'sellItem') continue;
      const lineTotal = this.computeLineTotal(item, currencies);
      if (!lineTotal) continue;
      total += costInStandard(lineTotal, currencies);
    }
    return total;
  }

  /** Net = purchases − sales. May be negative (player is owed money). */
  computeNetTotalInStandard(currencies) {
    return this.computePurchaseTotalInStandard(currencies) - this.computeSellTotalInStandard(currencies);
  }

  /** Sum all cart line totals into standard currency units (float). Returns 0 if cart has no priced items. */
  computeTotalInStandard(currencies) {
    return this.computePurchaseTotalInStandard(currencies);
  }

  /**
   * Returns a single { amount, currencyId } for the NET amount owed by the player.
   * Returns null if net ≤ 0 (no payment needed — player is owed money or balanced).
   * Used for PurchaseDialog checkout math.
   */
  computeCartTotal(currencies) {
    const standardCurrency = currencies.find(c => c.isStandard);
    if (!standardCurrency) return null;

    const netStandard = this.computeNetTotalInStandard(currencies);
    if (netStandard <= 0) return null;

    return this.#denominateInStandard(netStandard, standardCurrency, currencies);
  }

  /** Returns { amount, currencyId } for the amount the player is owed (net < 0). Null if not owed. */
  computeCreditTotal(currencies) {
    const standardCurrency = currencies.find(c => c.isStandard);
    if (!standardCurrency) return null;
    const netStandard = this.computeNetTotalInStandard(currencies);
    if (netStandard >= 0) return null;
    return this.#denominateInStandard(Math.abs(netStandard), standardCurrency, currencies);
  }

  /**
   * Convert a standard-unit amount into the most appropriate single-currency display value.
   * Always prefers the standard currency when it yields a whole number, only falling back
   * to other denominations when the standard currency would produce a fraction.
   */
  #denominateInStandard(amountStd, standardCurrency, currencies) {
    const EPSILON = 1e-9;
    const stdRate = parseExchangeRate(standardCurrency.exchangeRate);
    if (stdRate > EPSILON) {
      const stdAmount = amountStd / stdRate;
      if (Math.abs(stdAmount - Math.round(stdAmount)) < EPSILON) {
        return { amount: Math.round(stdAmount), currencyId: standardCurrency.id };
      }
    }
    const sorted = [...currencies].sort((a, b) => parseExchangeRate(a.exchangeRate) - parseExchangeRate(b.exchangeRate));
    for (const c of sorted) {
      const rate = parseExchangeRate(c.exchangeRate);
      if (rate < EPSILON) continue;
      const amount = amountStd / rate;
      if (Math.abs(amount - Math.round(amount)) < EPSILON) {
        return { amount: Math.round(amount), currencyId: c.id };
      }
    }
    return { amount: Math.ceil(amountStd), currencyId: standardCurrency.id };
  }

  #notify() {
    Hooks.call(CART_HOOK, this.#items);
  }
}

export const cartManager = new CartManager();
