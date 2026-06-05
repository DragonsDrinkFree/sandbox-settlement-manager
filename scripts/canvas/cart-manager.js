import { getWorldTimeConfig } from '../time/world-time.js';
import { costInStandard, parseExchangeRate } from '../utils/currency-utils.js';

export const CART_HOOK = 'sandboxSettlementManagerCartUpdated';

class CartManager {
  #items = [];

  get items() { return foundry.utils.deepClone(this.#items); }

  /** Add a lodging to the cart. Multiple entries for the same lodging are allowed (separate bookings). */
  addLodging({ sceneId, resourceId, resourceName, lodging }) {
    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'lodging',
      sceneId,
      resourceId,
      resourceName,
      lodgingId: lodging.id,
      lodgingName: lodging.name,
      beds: lodging.beds ?? 1,
      pricePerDay:  lodging.pricePerDay  ?? null,
      pricePerWeek: lodging.pricePerWeek ?? null,
      duration: 1,
      unit: 'days'
    });
    this.#notify();
  }

  /** Add a merchant inventory item to the cart. */
  addMerchantItem({ sceneId, resourceId, resourceName, item }) {
    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'merchantItem',
      sceneId,
      resourceId,
      resourceName,
      inventoryItemId: item.id,
      itemName: item.name,
      itemLinkedId: item.itemId ?? null,
      price: item.price ?? null,
      quantity: 1
    });
    this.#notify();
  }

  /** Add a menu item to the cart. Price is resolved from item first, then course default. */
  addMenuItem({ sceneId, resourceId, resourceName, course, item }) {
    const resolvedPrice = item.price ?? course.price ?? null;
    this.#items.push({
      id: foundry.utils.randomID(),
      type: 'menuItem',
      sceneId,
      resourceId,
      resourceName,
      courseId: course.id,
      itemId: item.id,
      itemName: item.name,
      itemLinkedId: item.itemId ?? null,
      price: resolvedPrice,
      quantity: 1
    });
    this.#notify();
  }

  updateItem(cartId, updates) {
    const item = this.#items.find(i => i.id === cartId);
    if (!item) return;
    Object.assign(item, updates);
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
      const { daysPerWeek } = getWorldTimeConfig();
      if (item.unit === 'weeks') {
        if (item.pricePerWeek) {
          return { amount: Math.round(item.pricePerWeek.amount * item.duration), currencyId: item.pricePerWeek.currencyId };
        }
        if (item.pricePerDay) {
          return { amount: Math.round(item.pricePerDay.amount * daysPerWeek * item.duration), currencyId: item.pricePerDay.currencyId };
        }
        return null;
      } else {
        if (item.pricePerDay) {
          return { amount: Math.round(item.pricePerDay.amount * item.duration), currencyId: item.pricePerDay.currencyId };
        }
        return null;
      }
    }
    if (item.type === 'menuItem' || item.type === 'merchantItem') {
      if (!item.price) return null;
      return { amount: Math.round(item.price.amount * item.quantity), currencyId: item.price.currencyId };
    }
    return null;
  }

  /** Sum all cart line totals into standard currency units (float). Returns 0 if cart has no priced items. */
  computeTotalInStandard(currencies) {
    let total = 0;
    for (const item of this.#items) {
      const lineTotal = this.computeLineTotal(item, currencies);
      if (!lineTotal) continue;
      total += costInStandard(lineTotal, currencies);
    }
    return total;
  }

  /**
   * Returns a single { amount, currencyId } expense for PurchaseDialog — picks the smallest
   * denomination that expresses the total as a whole number. Used for checkout math, not display.
   */
  computeCartTotal(currencies) {
    const standardCurrency = currencies.find(c => c.isStandard);
    if (!standardCurrency) return null;

    const totalStandard = this.computeTotalInStandard(currencies);
    if (totalStandard <= 0) return null;

    const EPSILON = 1e-9;
    const sorted = [...currencies].sort((a, b) => parseExchangeRate(a.exchangeRate) - parseExchangeRate(b.exchangeRate));
    for (const c of sorted) {
      const rate = parseExchangeRate(c.exchangeRate);
      if (rate < EPSILON) continue;
      const amount = totalStandard / rate;
      if (Math.abs(amount - Math.round(amount)) < EPSILON) {
        return { amount: Math.round(amount), currencyId: c.id };
      }
    }

    return { amount: Math.ceil(totalStandard), currencyId: standardCurrency.id };
  }

  #notify() {
    Hooks.call(CART_HOOK, this.#items);
  }
}

export const cartManager = new CartManager();
