import { MODULE_ID, FLAGS, SETTINGS, RESOURCE_TYPE_IDS, getTypeEntries } from "../constants.js";
import { mergePurchasingProfiles } from "./purchasing-utils.js";
import { SOCKET_CHANNEL, SOCKET_TYPES } from "../socket.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class PurchasingProfileEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _resource;
  _overrides = [];

  constructor(resource, options = {}) {
    super(options);
    this._resource  = resource;
    this._overrides = foundry.utils.deepClone(resource.typeData?.merchant?.purchasingOverrides ?? []);
  }

  get title() { return game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.editProfile"); }

  static DEFAULT_OPTIONS = {
    id:   `${MODULE_ID}-purchasing-profile-edit`,
    tag:  "form",
    form: { handler: PurchasingProfileEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 520 },
    actions: {
      deleteRule:    PurchasingProfileEditApp.#onDeleteRule,
      addOverride:   PurchasingProfileEditApp.#onAddOverride
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/purchasing-profile-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static async open(resource) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-purchasing-profile-edit`);
    if (existing) existing.close();
    return new Promise(resolve => {
      const app = new PurchasingProfileEditApp(foundry.utils.deepClone(resource));
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const effectiveProfile = mergePurchasingProfiles(this._resource);

    const rawTypes = game.system.documentTypes?.Item ?? [];
    const systemItemTypes = [
      { value: "", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.settlementSizeAll") },
      ...(Array.isArray(rawTypes) ? rawTypes : Object.keys(rawTypes))
        .filter(t => t !== "base")
        .map(t => ({ value: t, label: CONFIG.Item?.typeLabels?.[t] ?? t }))
    ];

    const buybackTypeOptions = [
      { value: "player", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.buybackPlayer") },
      { value: "full",   label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.buybackFull") }
    ];

    const displayRules = effectiveProfile.map(rule => ({
      ...rule,
      itemTypeLabel: rule.itemType
        ? (CONFIG.Item?.typeLabels?.[rule.itemType] ?? rule.itemType)
        : game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.settlementSizeAll"),
      buybackLabel: buybackTypeOptions.find(o => o.value === rule.buybackType)?.label ?? rule.buybackType,
      isOverride:   rule._source === "override"
    }));

    return {
      displayRules,
      overrides: this._overrides,
      systemItemTypes,
      buybackTypeOptions,
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "Save" }
      ]
    };
  }

  static async #onDeleteRule(event, target) {
    const itemType = target.dataset.itemType ?? "";
    const typeLabel = itemType
      ? (CONFIG.Item?.typeLabels?.[itemType] ?? itemType)
      : game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.settlementSizeAll");
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.disableRuleTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.merchant.disableRuleConfirm", { type: typeLabel })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.merchant.disableRuleTitle"), icon: "fa-solid fa-ban" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;
    // Add a disable override (buyRate: null) for this item type
    const existing = this._overrides.find(o => o.itemType === itemType);
    if (existing) {
      existing.buyRate = null;
    } else {
      this._overrides.push({ id: foundry.utils.randomID(), itemType, buyRate: null, buybackType: "player", buybackMarkup: 100 });
    }
    this.render({ parts: ["form"] });
  }

  static #onAddOverride() {
    const addRow = this.element.querySelector('.purchasing-add-row');
    if (!addRow) return;
    const itemType    = addRow.querySelector('[data-field="overrideItemType"]')?.value ?? "";
    const buyRate     = parseFloat(addRow.querySelector('[data-field="overrideBuyRate"]')?.value);
    const buybackType = addRow.querySelector('[data-field="overrideBuybackType"]')?.value ?? "player";
    if (isNaN(buyRate) || buyRate < 0) return;
    const existing = this._overrides.find(o => o.itemType === itemType);
    if (existing) {
      Object.assign(existing, { buyRate: Math.min(100, buyRate), buybackType });
    } else {
      this._overrides.push({ id: foundry.utils.randomID(), itemType, buyRate: Math.min(100, buyRate), buybackType });
    }
    this.render({ parts: ["form"] });
  }

  static async #onSubmit(event, form, formData) {
    const resources = foundry.utils.deepClone(
      canvas.scene?.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? []
    );
    const resource = resources.find(r => r.id === this._resource.id);
    if (!resource) { this._resolve?.(null); return; }

    resource.typeData ??= {};
    resource.typeData.merchant ??= {};
    resource.typeData.merchant.purchasingOverrides = this._overrides;

    if (game.user.isGM) {
      await canvas.scene?.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
    } else {
      game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPES.SAVE_RESOURCE, sceneId: canvas.scene?.id, resource });
    }

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(this._overrides);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
