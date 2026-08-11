import { MODULE_ID } from "../constants.js";
import { StorageAccessAddApp } from "./storage-access-add-app.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Player-facing dialog for a Primary Group member to manage the Guest roster themselves, without
 * needing the GM. Primary membership itself is untouchable here — only Guests can be added/removed.
 * Each add/remove saves immediately (via the caller-supplied callbacks) and the dialog re-renders
 * from the freshly-saved group, mirroring how every other player-facing Storage action already
 * mutates-and-saves live rather than deferring to a form submit.
 */
export class StorageAccessManageApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _group;           // display-ready group: { id, name, access: [{actorId, actorName, level, isPrimary}] }
  _candidateActors; // [{ id, name, type, hasPlayerOwner }] — pre-filtered by the caller (excludes current members, Observer-eligible only)
  _onAdd;           // async (entries) => updated display-ready group
  _onRemove;        // async (actorId) => updated display-ready group

  constructor(group, { candidateActors, onAdd, onRemove }, options = {}) {
    super(options);
    this._group           = group;
    this._candidateActors = candidateActors;
    this._onAdd           = onAdd;
    this._onRemove        = onRemove;
  }

  get title() {
    return game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.storage.access.manageGuestsTitle", { name: this._group.name });
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-storage-access-manage`,
    position: { width: 380 },
    actions: {
      addGuest:         StorageAccessManageApp.#onAddGuest,
      removeGuest:      StorageAccessManageApp.#onRemoveGuest,
      closeManageGuests: StorageAccessManageApp.#onCloseManageGuests
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/canvas/storage-access-manage.hbs` }
  };

  static open(group, context) {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-storage-access-manage`);
    if (existing) existing.close();
    new StorageAccessManageApp(group, context).render(true);
  }

  async _prepareContext(options) {
    return { groupName: this._group.name, members: this._group.access ?? [] };
  }

  static async #onAddGuest() {
    const existingIds = new Set((this._group.access ?? []).map(a => a.actorId));
    const candidates = this._candidateActors.filter(a => !existingIds.has(a.id));
    if (!candidates.length) {
      ui.notifications.info(game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.access.noCandidates"));
      return;
    }
    const result = await StorageAccessAddApp.open(candidates, { allowLevelChoice: false });
    if (!result) return;
    const updated = await this._onAdd(result);
    if (updated) { this._group = updated; this.render(); }
  }

  static async #onRemoveGuest(event, target) {
    const actorId = target.dataset.actorId;
    const entry = (this._group.access ?? []).find(a => a.actorId === actorId);
    if (!entry || entry.isPrimary) return; // defense in depth — this dialog may only ever touch Guests

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.access.removeGuestTitle") },
      content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.storage.access.removeGuestConfirm", { name: entry.actorName })}</p>`,
      yes: { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.location.delete"), icon: "fa-solid fa-trash" },
      no:  { label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.cancel") }
    });
    if (!confirmed) return;

    const updated = await this._onRemove(actorId);
    if (updated) { this._group = updated; this.render(); }
  }

  static #onCloseManageGuests() {
    this.close();
  }
}
