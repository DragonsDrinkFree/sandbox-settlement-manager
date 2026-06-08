import { MODULE_ID, SETTINGS, FLAGS } from '../constants.js';
import { CART_HOOK, cartManager } from './cart-manager.js';
import { PurchaseDialog } from './purchase-dialog.js';
import { calculateChange, formatAmounts, parseExchangeRate, costInStandard, getSettlementMaxDenomValue, grantStandardToActor, removeCoinsFromActor, readActorBalance } from '../utils/currency-utils.js';
import { getWorldTimeConfig } from '../time/world-time.js';
import { SOCKET_CHANNEL, SOCKET_TYPES } from '../socket.js';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CartApp extends HandlebarsApplicationMixin(ApplicationV2) {
  #cartHook = null;
  #positioned = false;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-cart`,
    classes: ['ssm-cart-panel'],
    window: { title: 'SANDBOX_SETTLEMENT_MANAGER.cart.title', resizable: false },
    position: { width: 300 },
    actions: {
      removeItem: CartApp.#onRemoveItem,
      clearCart:  CartApp.#onClearCart,
      checkout:   CartApp.#onCheckout
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/cart-app.hbs` }
  };

  /** Opens the cart, or returns the existing instance (hook already re-renders it). */
  static open() {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-cart`);
    if (existing) return existing;
    const app = new CartApp();
    app.render(true, { focus: false });
    return app;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const currencies = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
    const rawItems = cartManager.items;

    const settlementMaxDenomValue = getSettlementMaxDenomValue(currencies);

    const formatStandard = (std) => {
      if (std <= 0) return '—';
      const maxRate = currencies.reduce((max, c) => Math.max(max, parseExchangeRate(c.exchangeRate)), 0);
      const breakdown = calculateChange(std, currencies, maxRate);
      if (breakdown && Object.values(breakdown).some(v => v > 0)) return formatAmounts(breakdown, currencies);
      const sc = currencies.find(c => c.isStandard);
      return sc ? `${Math.ceil(std)} ${sc.abbreviation}` : '—';
    };

    const formatConstrained = (std) => {
      if (std <= 0) return '—';
      const breakdown = calculateChange(std, currencies, settlementMaxDenomValue);
      if (breakdown && Object.values(breakdown).some(v => v > 0)) return formatAmounts(breakdown, currencies);
      const eligible = [...currencies]
        .filter(c => parseExchangeRate(c.exchangeRate) <= settlementMaxDenomValue + 1e-9)
        .sort((a, b) => parseExchangeRate(a.exchangeRate) - parseExchangeRate(b.exchangeRate));
      const sc = eligible[0] ?? currencies.find(c => c.isStandard);
      return sc ? `${Math.ceil(std / parseExchangeRate(sc.exchangeRate))} ${sc.abbreviation}` : '—';
    };

    const purchaseItems = [];
    const sellItems     = [];

    const globalMaxDenom = currencies.reduce((m, c) => Math.max(m, parseExchangeRate(c.exchangeRate)), 0);

    for (const item of rawItems) {
      const lineTotal = cartManager.computeLineTotal(item, currencies);
      let lineTotalLabel = '—';
      const mapped = { ...item, isLodging: item.type === 'lodging', isSellItem: item.type === 'sellItem', isExchange: item.type === 'exchange', lineTotalLabel };

      if (item.type === 'exchange') {
        const fromCurr = currencies.find(c => c.id === item.fromCurrencyId);
        const toCurr   = currencies.find(c => c.id === item.toCurrencyId);
        const fromRate = fromCurr ? parseExchangeRate(fromCurr.exchangeRate) : 0;
        const toRate   = toCurr   ? parseExchangeRate(toCurr.exchangeRate)   : 0;
        const toAmount = (fromRate > 0 && toRate > 0) ? Math.floor(item.fromAmount * fromRate / toRate) : 0;
        const feeStd   = lineTotal ? costInStandard(lineTotal, currencies) : 0;
        lineTotalLabel = feeStd > 1e-9
          ? formatAmounts(calculateChange(feeStd, currencies, globalMaxDenom) ?? {}, currencies)
          : '—';
        mapped.lineTotalLabel   = lineTotalLabel;
        mapped.fromAbbreviation = fromCurr?.abbreviation ?? '?';
        mapped.toAmount         = toAmount;
        mapped.toAbbreviation   = toCurr?.abbreviation   ?? '?';
        purchaseItems.push(mapped);
        continue;
      }

      if (lineTotal) {
        if (item.type === 'sellItem') {
          lineTotalLabel = formatConstrained(costInStandard(lineTotal, currencies));
        } else {
          const curr = currencies.find(c => c.id === lineTotal.currencyId);
          lineTotalLabel = `${lineTotal.amount} ${curr?.abbreviation ?? '?'}`;
        }
        mapped.lineTotalLabel = lineTotalLabel;
      }
      if (item.type === 'sellItem') sellItems.push(mapped);
      else purchaseItems.push(mapped);
    }

    const purchaseStd = cartManager.computePurchaseTotalInStandard(currencies);
    const sellStd     = cartManager.computeSellTotalInStandard(currencies);
    const netStd      = purchaseStd - sellStd;

    const purchaseTotalLabel = formatStandard(purchaseStd);
    const sellTotalLabel     = formatConstrained(sellStd);
    const netTotalLabel      = netStd >= -1e-9 ? formatStandard(Math.abs(netStd)) : formatConstrained(Math.abs(netStd));
    const isNetCredit        = netStd < -1e-9;
    const isBalanced         = Math.abs(netStd) < 1e-9 && (purchaseItems.length || sellItems.length);

    const youReceiveLabel = isNetCredit ? formatConstrained(Math.abs(netStd)) : null;
    const isEmpty = rawItems.length === 0;

    return {
      ...context,
      purchaseItems, sellItems,
      hasSellItems:     sellItems.length > 0,
      hasPurchaseItems: purchaseItems.length > 0,
      purchaseTotalLabel, sellTotalLabel, netTotalLabel,
      isNetCredit, isBalanced, youReceiveLabel,
      isEmpty
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    // Register cart hook once per open session
    if (!this.#cartHook) {
      this.#cartHook = Hooks.on(CART_HOOK, () => this.render({ parts: ['content'] }));
    }

    // Auto-position to the right of settlement-manage on first render
    if (!this.#positioned) {
      this.#positioned = true;
      const anchor = foundry.applications.instances.get(`${MODULE_ID}-settlement-manage`);
      if (anchor?.position) {
        const { top, left, width } = anchor.position;
        this.setPosition({ top, left: left + width + 8 });
      }
    }

    // Wire duration inputs
    this.element.querySelectorAll('.ssm-cart-duration').forEach(input => {
      input.addEventListener('change', () => {
        const val = Math.max(1, parseInt(input.value) || 1);
        cartManager.updateItem(input.dataset.cartId, { duration: val });
      });
    });

    // Wire unit selects
    this.element.querySelectorAll('.ssm-cart-unit').forEach(select => {
      select.addEventListener('change', () => {
        cartManager.updateItem(select.dataset.cartId, { unit: select.value });
      });
    });

    // Wire quantity inputs
    this.element.querySelectorAll('.ssm-cart-quantity').forEach(input => {
      input.addEventListener('change', () => {
        const val = Math.max(1, parseInt(input.value) || 1);
        cartManager.updateItem(input.dataset.cartId, { quantity: val });
      });
    });

    // Wire item sheet links for sell items
    this.element.querySelectorAll('.ssm-item-link[data-uuid]').forEach(link => {
      link.addEventListener('click', async () => {
        const item = await fromUuid(link.dataset.uuid).catch(() => null);
        item?.sheet?.render(true);
      });
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    if (this.#cartHook !== null) {
      Hooks.off(CART_HOOK, this.#cartHook);
      this.#cartHook = null;
    }
    this.#positioned = false;
  }

  // ------------------------------------------------------------------ actions

  static #onRemoveItem(event, target) {
    cartManager.removeItem(target.dataset.cartId);
  }

  static #onClearCart() {
    cartManager.clear();
  }

  static async #onCheckout() {
    const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG);
    const currencies     = currencyConfig.currencies ?? [];
    const mode           = currencyConfig.mode ?? 'loose';
    const items          = cartManager.items;

    const netStd    = cartManager.computeNetTotalInStandard(currencies);
    const sellItems = items.filter(i => i.type === 'sellItem');
    const actorId   = sellItems[0]?.actorId ?? null;
    const maxDenomValue = getSettlementMaxDenomValue(currencies);

    if (netStd > 1e-9) {
      // Player owes money — open PurchaseDialog with net amount
      const total = cartManager.computeCartTotal(currencies);
      if (!total || total.amount <= 0) return;
      const expense = { id: 'cart-total', name: game.i18n.localize('SANDBOX_SETTLEMENT_MANAGER.cart.title'), ...total };
      const result = await PurchaseDialog.open({ expense, currencies, mode });
      if (!result) return;
      await CartApp.#processFulfillments(items, result.actorId, currencies, mode);
    } else if (netStd < -1e-9) {
      // Merchant owes player — grant currency constrained to settlement denomination
      await grantStandardToActor(game.actors.get(actorId), Math.abs(netStd), currencies, mode, maxDenomValue);
      await CartApp.#processFulfillments(items, actorId, currencies, mode);
    } else {
      // Balanced — just fulfill both sides
      if (!items.length) return;
      await CartApp.#processFulfillments(items, actorId, currencies, mode);
    }

    cartManager.clear();
  }

  /** After a successful payment, create ledger entries, grant linked items, and fulfill sell items. */
  static async #processFulfillments(items, actorId, currencies = [], mode = 'loose') {
    const { hoursPerDay, daysPerWeek } = getWorldTimeConfig();
    const secondsPerDay  = hoursPerDay * 3600;
    const secondsPerWeek = secondsPerDay * daysPerWeek;

    // Group lodging items by sceneId so we update each scene's flags once
    const byScene = new Map();
    for (const item of items) {
      if (item.type !== 'lodging') continue;
      if (!byScene.has(item.sceneId)) byScene.set(item.sceneId, []);
      byScene.get(item.sceneId).push(item);
    }

    const actorName = actorId ? (game.actors.get(actorId)?.name ?? '') : '';

    for (const [sceneId, sceneItems] of byScene) {
      const scene = game.scenes.get(sceneId);
      if (!scene) continue;

      const locations  = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
      const dirtyIds   = new Set();

      for (const cartItem of sceneItems) {
        const location = locations.find(r => r.id === cartItem.locationId);
        const inn = location?.typeData?.inn;
        if (!inn) continue;

        const durationSeconds = cartItem.unit === 'weeks'
          ? cartItem.duration * secondsPerWeek
          : cartItem.duration * secondsPerDay;

        const purchasedAt = game.time.worldTime;
        inn.ledger ??= [];
        inn.ledger.push({
          id: foundry.utils.randomID(),
          lodgingId:       cartItem.lodgingId,
          lodgingName:     cartItem.lodgingName,
          beds:            cartItem.beds,
          actorId:         actorId ?? '',
          actorName,
          purchasedAt,
          durationSeconds,
          expiresAt: purchasedAt + durationSeconds
        });

        const lodging = (inn.lodgings ?? []).find(l => l.id === cartItem.lodgingId);
        if (lodging && typeof lodging.availability === 'number') {
          lodging.availability = Math.max(0, lodging.availability - 1);
        }
        dirtyIds.add(cartItem.locationId);
      }

      if (!dirtyIds.size) continue;

      if (game.user.isGM) {
        await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
      } else {
        for (const locationId of dirtyIds) {
          const location = locations.find(r => r.id === locationId);
          if (location) {
            game.socket.emit(SOCKET_CHANNEL, {
              type: SOCKET_TYPES.SAVE_LOCATION,
              sceneId: scene.id,
              location
            });
          }
        }
      }
    }

    // Grant linked Foundry items to the purchasing actor
    const actor = actorId ? game.actors.get(actorId) : null;
    if (actor) {
      for (const item of items.filter(i => (i.type === 'menuItem' || i.type === 'merchantItem') && i.itemLinkedId)) {
        const source = await fromUuid(item.itemLinkedId).catch(() => null);
        if (source) {
          const itemData = source.toObject();
          for (let q = 0; q < (item.quantity ?? 1); q++) {
            await actor.createEmbeddedDocuments('Item', [itemData]);
          }
        }
      }
    }

    // Fulfill sell items: remove from actor and cache in merchant buyback list
    const sellItems = items.filter(i => i.type === 'sellItem');

    // Group buyback entries by sceneId + locationId
    const buybackByLocation = new Map(); // key: `${sceneId}:${locationId}`

    if (sellItems.length) for (const sellItem of sellItems) {
      const sellerActor = game.actors.get(sellItem.actorId);
      if (!sellerActor) continue;
      const actorItem = sellerActor.items.get(sellItem.actorItemId);
      if (!actorItem) continue;

      const qty        = sellItem.quantity ?? 1;
      const currentQty = foundry.utils.getProperty(actorItem, 'system.quantity') ?? 1;
      if (currentQty <= qty) {
        await actorItem.delete();
      } else {
        await actorItem.update({ 'system.quantity': currentQty - qty });
      }

      const key = `${sellItem.sceneId}:${sellItem.locationId}`;
      if (!buybackByLocation.has(key)) buybackByLocation.set(key, { sceneId: sellItem.sceneId, locationId: sellItem.locationId, entries: [] });
      buybackByLocation.get(key).entries.push({
        id:             foundry.utils.randomID(),
        itemName:       sellItem.itemName,
        itemLinkedUuid: sellItem.itemLinkedUuid ?? null,
        itemData:       actorItem.toObject(),
        salePrice:      sellItem.salePrice,
        buybackPrice:   sellItem.salePrice, // default player-price; profile edit can adjust
        soldAt:         game.time.worldTime
      });
    }

    // Save buyback entries to merchant data on the appropriate scenes
    for (const { sceneId, locationId, entries } of buybackByLocation.values()) {
      const scene = game.scenes.get(sceneId);
      if (!scene) continue;
      const locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
      const location  = locations.find(r => r.id === locationId);
      if (!location) continue;
      location.typeData ??= {};
      location.typeData.merchant ??= {};
      location.typeData.merchant.buybackItems = [
        ...(location.typeData.merchant.buybackItems ?? []),
        ...entries
      ];
      if (game.user.isGM) {
        await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
      } else {
        game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.SAVE_LOCATION, sceneId: scene.id, location });
      }
    }

    // Fulfill exchange items: take fromCurrency, grant toCurrency (fee already paid via PurchaseDialog)
    const exchangeItems = items.filter(i => i.type === 'exchange');
    for (const exItem of exchangeItems) {
      const exActor = game.actors.get(exItem.actorId);
      if (!exActor || mode === 'loose') continue;

      const fromCurr = currencies.find(c => c.id === exItem.fromCurrencyId);
      const toCurr   = currencies.find(c => c.id === exItem.toCurrencyId);
      if (!fromCurr || !toCurr) continue;

      // Trick-prevention: check how much fromCurrency remains after fee payment
      const actualBalance = readActorBalance(exActor, fromCurr, mode);
      const actualFromAmt = Math.min(exItem.fromAmount, actualBalance);
      if (actualFromAmt <= 0) continue;

      const actualFromStd = actualFromAmt * parseExchangeRate(fromCurr.exchangeRate);
      const toRate        = parseExchangeRate(toCurr.exchangeRate);

      // Grant the to-currency, capped at toCurrency denomination (no higher-value coins)
      await grantStandardToActor(exActor, actualFromStd, currencies, mode, toRate);
      // Remove the from-currency
      await removeCoinsFromActor(exActor, { [fromCurr.id]: actualFromAmt }, currencies, mode);
    }

    // Refresh any open bank location windows so displayed balances stay current
    if (exchangeItems.length > 0 && mode !== 'loose') {
      for (const app of foundry.applications.instances.values()) {
        if (app.id === 'sandbox-settlement-manager-location-detail') app.render();
        else if (app.id === 'sandbox-settlement-manager-settlement-manage') app.render({ parts: ['content'] });
      }
    }
  }

}
