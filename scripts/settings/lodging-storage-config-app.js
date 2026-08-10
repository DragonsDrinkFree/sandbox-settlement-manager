import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only dialog for configuring how a single Default Lodgings row auto-creates a Storage Area on
 * rental: which Storage Type (from the Inn's attached Storage template) to use, an optional
 * retrieval-policy override, the Area naming template (e.g. "Room: ", auto-numbered), and whether
 * the renter loses access to that Area when the lodging expires.
 */
export class LodgingStorageConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _lodging;      // the lodging row being configured
  _storageTypes; // [{ id, name }] from the Inn's currently-linked Storage template

  constructor(lodging, storageTypes, options = {}) {
    super(options);
    this._lodging      = lodging;
    this._storageTypes = storageTypes;
  }

  get title() {
    return game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.inn.lodging.storageConfigTitle", { name: this._lodging?.name || "" });
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-lodging-storage-config`,
    tag: "form",
    classes: ["standard-form"],
    form: { handler: LodgingStorageConfigApp.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    actions: {
      cancel: LodgingStorageConfigApp.#onCancel
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/settings/lodging-storage-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Open the dialog. Resolves with the edited storage config, or null if cancelled. */
  static async open(lodging, storageTypes) {
    return new Promise(resolve => {
      const app = new LodgingStorageConfigApp(lodging, storageTypes);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const config = this._lodging.storageConfig ?? {};
    return {
      storageTypeOptions: this._storageTypes.map(st => ({
        id: st.id, name: st.name, selected: st.id === config.storageTypeId
      })),
      policyOptions: [
        { value: "",              label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.group.policyInherit"), selected: !config.retrievalPolicyOverride },
        { value: "anyone",        label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.policyAnyone"),        selected: config.retrievalPolicyOverride === "anyone" },
        { value: "depositorOnly", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.policyDepositorOnly"), selected: config.retrievalPolicyOverride === "depositorOnly" }
      ],
      namingTemplate:      config.namingTemplate ?? "",
      loseAccessOnExpiry:  !!config.loseAccessOnExpiry,
      buttons: [
        { type: "submit", icon: "fa-solid fa-save",   label: "Save" },
        { type: "button", action: "cancel", icon: "fa-solid fa-xmark", label: "SANDBOX_SETTLEMENT_MANAGER.dialog.cancel" }
      ]
    };
  }

  static #onCancel() {
    this.close();
  }

  static async #onSubmit(event, form, formData) {
    const storageTypeId     = formData.object.storageTypeId || null;
    const retrievalPolicyOverride = formData.object.retrievalPolicyOverride || null;
    const namingTemplate    = (formData.object.namingTemplate ?? "").trim();
    const loseAccessOnExpiry = !!formData.object.loseAccessOnExpiry;

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({ storageTypeId, retrievalPolicyOverride, namingTemplate, loseAccessOnExpiry });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
