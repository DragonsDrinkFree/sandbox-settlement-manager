import { MODULE_ID, SETTINGS, FLAGS } from '../constants.js';
import { CART_HOOK, cartManager } from './cart-manager.js';
import { PurchaseDialog } from './purchase-dialog.js';
import { calculateChange, formatAmounts, parseExchangeRate } from '../utils/currency-utils.js';
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

    const items = rawItems.map(item => {
      const lineTotal = cartManager.computeLineTotal(item, currencies);
      let lineTotalLabel = '—';
      if (lineTotal) {
        const curr = currencies.find(c => c.id === lineTotal.currencyId);
        lineTotalLabel = `${lineTotal.amount} ${curr?.abbreviation ?? '?'}`;
      }
      return { ...item, isLodging: item.type === 'lodging', lineTotalLabel };
    });

    const totalStandard = cartManager.computeTotalInStandard(currencies);
    let cartTotalLabel = '—';
    if (totalStandard > 0) {
      const maxRate = currencies.reduce((max, c) => Math.max(max, parseExchangeRate(c.exchangeRate)), 0);
      const breakdown = calculateChange(totalStandard, currencies, maxRate);
      if (breakdown && Object.values(breakdown).some(v => v > 0)) {
        cartTotalLabel = formatAmounts(breakdown, currencies);
      } else {
        const std = currencies.find(c => c.isStandard);
        cartTotalLabel = std ? `${Math.ceil(totalStandard)} ${std.abbreviation}` : '—';
      }
    }

    return { ...context, items, cartTotalLabel, isEmpty: items.length === 0 };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    // Register cart hook once per open session
    if (!this.#cartHook) {
      this.#cartHook = Hooks.on(CART_HOOK, () => this.render({ parts: ['content'] }));
    }

    // Auto-position to the right of city-manage on first render
    if (!this.#positioned) {
      this.#positioned = true;
      const anchor = foundry.applications.instances.get(`${MODULE_ID}-city-manage`);
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
    const currencies = currencyConfig.currencies ?? [];
    const total = cartManager.computeCartTotal(currencies);
    if (!total || total.amount <= 0) return;

    const expense = {
      id:   'cart-total',
      name: game.i18n.localize('SANDBOX_SETTLEMENT_MANAGER.cart.title'),
      ...total
    };

    const result = await PurchaseDialog.open({ expense, currencies, mode: currencyConfig.mode ?? 'loose' });
    if (!result) return;

    await CartApp.#processFulfillments(cartManager.items, result.actorId);
    cartManager.clear();
  }

  /** After a successful payment, create ledger entries and grant linked items. */
  static async #processFulfillments(items, actorId) {
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

      const resources  = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? []);
      const dirtyIds   = new Set();

      for (const cartItem of sceneItems) {
        const resource = resources.find(r => r.id === cartItem.resourceId);
        const inn = resource?.typeData?.inn;
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
        dirtyIds.add(cartItem.resourceId);
      }

      if (!dirtyIds.size) continue;

      if (game.user.isGM) {
        await scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
      } else {
        for (const resourceId of dirtyIds) {
          const resource = resources.find(r => r.id === resourceId);
          if (resource) {
            game.socket.emit(SOCKET_CHANNEL, {
              type: SOCKET_TYPES.SAVE_RESOURCE,
              sceneId: scene.id,
              resource
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
  }
}
