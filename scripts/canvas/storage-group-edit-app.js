import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only dialog for creating/editing a Storage Group: its name, which Storage Type it draws
 * capacity/default policy from, an optional per-group retrieval-policy override, and the explicit
 * list of actors granted access. Access lists are instance-only (never template data) — they're
 * assigned here, at the location level, not on the reusable Storage Type.
 */
export class StorageGroupEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _group;         // { id, name, storageTypeId, accessActorIds, retrievalPolicyOverride }
  _storageTypes;  // [{ id, name }]
  _actors;        // [{ id, name }]

  constructor(group, { storageTypes, actors }, options = {}) {
    super(options);
    this._group        = group;
    this._storageTypes = storageTypes;
    this._actors        = actors;
  }

  get title() {
    return game.i18n.localize(
      this._group?.id
        ? "SANDBOX_SETTLEMENT_MANAGER.storage.group.editTitle"
        : "SANDBOX_SETTLEMENT_MANAGER.storage.group.addTitle"
    );
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-storage-group-edit`,
    tag: "form",
    form: { handler: StorageGroupEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 420 },
    actions: {
      cancel: StorageGroupEditApp.#onCancel
    }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/storage-group-edit.hbs`, scrollable: [".storage-access-list"] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Open the dialog. Resolves with the edited group, or null if cancelled. */
  static async open(group, context) {
    return new Promise(resolve => {
      const app = new StorageGroupEditApp(foundry.utils.deepClone(group), context);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    return {
      name: this._group.name ?? "",
      storageTypeOptions: this._storageTypes.map(st => ({
        id: st.id, name: st.name, selected: st.id === this._group.storageTypeId
      })),
      policyOptions: [
        { value: "",              label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.group.policyInherit"),        selected: !this._group.retrievalPolicyOverride },
        { value: "anyone",        label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.policyAnyone"),               selected: this._group.retrievalPolicyOverride === "anyone" },
        { value: "depositorOnly", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.policyDepositorOnly"),        selected: this._group.retrievalPolicyOverride === "depositorOnly" }
      ],
      actorRows: this._actors.map(a => ({
        id: a.id, name: a.name, checked: (this._group.accessActorIds ?? []).includes(a.id)
      })),
      buttons: [
        { type: "submit", icon: "fa-solid fa-save",   label: "Save" },
        { type: "button", action: "cancel", icon: "fa-solid fa-xmark", label: "SANDBOX_SETTLEMENT_MANAGER.dialog.cancel" }
      ]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="name"]')?.focus();

    const filterInput = this.element.querySelector('.storage-access-filter');
    filterInput?.addEventListener('input', () => {
      const q = filterInput.value.trim().toLowerCase();
      this.element.querySelectorAll('.storage-access-row').forEach(row => {
        row.hidden = q && !row.dataset.actorName.toLowerCase().includes(q);
      });
    });
  }

  static #onCancel() {
    this.close();
  }

  static async #onSubmit(event, form, formData) {
    const name           = (formData.object.name ?? "").trim();
    const storageTypeId  = formData.object.storageTypeId ?? null;
    const policyOverride = formData.object.retrievalPolicyOverride || null;
    const accessActorIds = [...form.querySelectorAll('.storage-access-actor-checkbox:checked')]
      .map(cb => cb.dataset.actorId);

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._group.id || foundry.utils.randomID(),
      name,
      storageTypeId,
      accessActorIds,
      retrievalPolicyOverride: policyOverride
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
