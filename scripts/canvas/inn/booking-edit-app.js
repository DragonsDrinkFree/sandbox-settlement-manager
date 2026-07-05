import { MODULE_ID } from "../../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * GM-only dialog for adding or editing an inn booking (ledger entry).
 * Add mode (no `booking` passed): GM picks a lodging, an actor, and a duration in days —
 * created entirely free, no cart/payment involved (the GM "playing innkeeper").
 * Edit mode (existing `booking` passed): GM can reassign the actor and change the remaining
 * days; which lodging the booking is for is not editable.
 * The dialog only resolves the requested changes — the caller (location-detail-app.js /
 * settlement-manage-app.js) applies them to the ledger and keeps availability in sync.
 */
export class BookingEditApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _resolve = null;
  _booking;      // existing booking entry, or null when adding
  _lodgings;     // [{ id, name, beds }] — raw inn lodgings, for the add-mode picker
  _actors;       // [{ id, name }]
  _secondsPerDay;
  _now;

  constructor(booking, { lodgings, actors, secondsPerDay, now }, options = {}) {
    super(options);
    this._booking       = booking ?? null;
    this._lodgings       = lodgings;
    this._actors         = actors;
    this._secondsPerDay = secondsPerDay;
    this._now           = now;
  }

  get title() {
    return game.i18n.localize(
      this._booking
        ? "SANDBOX_SETTLEMENT_MANAGER.inn.booking.editTitle"
        : "SANDBOX_SETTLEMENT_MANAGER.inn.booking.addTitle"
    );
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-booking-edit`,
    tag: "form",
    form: { handler: BookingEditApp.#onSubmit, closeOnSubmit: true },
    position: { width: 360 }
  };

  static PARTS = {
    form:   { template: `modules/${MODULE_ID}/templates/canvas/inn/booking-edit.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Open the dialog. Resolves with { isAdd, lodgingId?, actorId, actorName, days } or null if cancelled. */
  static async open(booking, context) {
    return new Promise(resolve => {
      const app = new BookingEditApp(booking, context);
      app._resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const isAdd = !this._booking;
    const days = isAdd
      ? 1
      : Math.max(0, Math.ceil((this._booking.expiresAt - this._now) / this._secondsPerDay));

    return {
      isAdd,
      lodgingName: this._booking?.lodgingName ?? "",
      lodgings: this._lodgings.map(l => ({ ...l, selected: l.id === this._booking?.lodgingId })),
      actors: this._actors.map(a => ({ ...a, selected: a.id === this._booking?.actorId })),
      days,
      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "Save" }]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector('[name="actorId"]')?.focus();
  }

  static async #onSubmit(event, form, formData) {
    const isAdd     = !this._booking;
    const actorId   = formData.object.actorId ?? this._booking?.actorId;
    const actorName = game.actors.get(actorId)?.name ?? this._booking?.actorName ?? "";
    const days      = Math.max(0, parseInt(formData.object.days) || 0);

    const resolve = this._resolve;
    this._resolve = null;
    resolve?.({
      isAdd,
      lodgingId: isAdd ? (formData.object.lodgingId ?? null) : undefined,
      actorId, actorName, days
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resolve?.(null);
    this._resolve = null;
  }
}
