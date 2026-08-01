import { MODULE_ID } from "../constants.js";
import { StorageAccessAddApp } from "./storage-access-add-app.js";
import { getGroupAccessList } from "../utils/storage-utils.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only dialog for creating/editing a Storage Group: its name, which Storage Type it draws
 * capacity/default policy from, an optional per-group retrieval-policy override, and the access
 * list (who has access and at what level — Primary or Guest). Access lists are instance-only
 * (never template data) — they're assigned here, at the location level, not on the reusable
 * Storage Type. Only the GM can add/remove/relevel Primary members here; a Primary member's own
 * (Guest-only) management powers live in the separate player-facing StorageAccessManageApp.
 */
export class StorageGroupEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _group;         // { id, name, storageTypeId, access, retrievalPolicyOverride }
  _storageTypes;  // [{ id, name }]
  _actors;        // [{ id, name, type, hasPlayerOwner }]
  _accessList;    // working [{ actorId, level }] — mutated in place, saved on submit

  constructor(group, { storageTypes, actors }, options = {}) {
    super(options);
    this._group        = group;
    this._storageTypes = storageTypes;
    this._actors        = actors;
    this._accessList    = getGroupAccessList(group).map(a => ({ ...a }));
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
      cancel:             StorageGroupEditApp.#onCancel,
      addAccessMembers:   StorageGroupEditApp.#onAddAccessMembers,
      removeAccessMember: StorageGroupEditApp.#onRemoveAccessMember
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
    const actorName = id => this._actors.find(a => a.id === id)?.name ?? game.actors.get(id)?.name ?? "?";
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
      accessRows: this._accessList.map(a => ({
        actorId:   a.actorId,
        actorName: actorName(a.actorId),
        isPrimary: a.level === "primary"
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

    this.element.querySelectorAll('.storage-access-level-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const entry = this._accessList.find(a => a.actorId === sel.dataset.actorId);
        if (entry) entry.level = sel.value;
      });
    });
  }

  static async #onAddAccessMembers() {
    const existingIds = new Set(this._accessList.map(a => a.actorId));
    const candidates = this._actors.filter(a => !existingIds.has(a.id));
    if (!candidates.length) {
      ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.access.noCandidates"));
      return;
    }
    const result = await StorageAccessAddApp.open(candidates, { allowLevelChoice: true });
    if (!result) return;
    this._accessList.push(...result);
    this.render({ parts: ["form"] });
  }

  static #onRemoveAccessMember(event, target) {
    const actorId = target.dataset.actorId;
    this._accessList = this._accessList.filter(a => a.actorId !== actorId);
    this.render({ parts: ["form"] });
  }

  static #onCancel() {
    this.close();
  }

  static async #onSubmit(event, form, formData) {
    const name           = (formData.object.name ?? "").trim();
    const storageTypeId  = formData.object.storageTypeId ?? null;
    const policyOverride = formData.object.retrievalPolicyOverride || null;

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      id: this._group.id || foundry.utils.randomID(),
      name,
      storageTypeId,
      access: this._accessList,
      retrievalPolicyOverride: policyOverride
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
