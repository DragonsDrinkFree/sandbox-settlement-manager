import { consumeLodgingAvailability } from "./lodging-utils.js";

/**
 * Shared lodging-booking fulfillment logic, used identically by cart checkout and the GM's manual
 * Add Booking tool (see cart-app.js and location-detail-app.js/settlement-manage-app.js's
 * #onAddBooking) so "rent a room" behaves the same regardless of entry point. Mutates the plain data
 * objects already reachable from `location` (`inn`, its lodgings, and its linked Storage entry if
 * any); callers are responsible for persisting afterward via whichever save path they already use.
 */

/** The receiving actor's active-or-expired-but-not-yet-reclaimed booking for this specific room, if any. */
export function findActiveBookingForLodging(inn, lodgingId, actorId) {
  return (inn?.ledger ?? []).find(e => e.lodgingId === lodgingId && e.actorId === actorId && !e.reclaimed) ?? null;
}

/**
 * Create a fresh booking ledger entry for `lodging`, consuming its availability. If the lodging has
 * storage configured (storageConfig.storageTypeId) and the Inn has a linked Storage entry on this
 * same Location, also creates a new Area there and grants the receiving actor Primary access,
 * incrementing the lodging's naming counter. Returns the new ledger entry.
 */
export function createNewLodgingBooking(location, inn, lodging, receivingActorId, receivingActorName, durationSeconds, now) {
  const entry = {
    id: foundry.utils.randomID(),
    lodgingId: lodging.id,
    lodgingName: lodging.name,
    beds: lodging.beds,
    actorId: receivingActorId ?? "",
    actorName: receivingActorName,
    purchasedAt: now,
    durationSeconds,
    expiresAt: now + durationSeconds,
    reclaimed: false,
    storageGroupId: null
  };

  consumeLodgingAvailability(inn, lodging.id);

  const storageTypeId = lodging.storageConfig?.storageTypeId ?? null;
  if (storageTypeId && inn.linkedStorageEntryId && receivingActorId) {
    const storageData = location.typeData?.[inn.linkedStorageEntryId];
    if (storageData) {
      const n = lodging.storageNextAreaNumber ?? 1;
      const group = {
        id: foundry.utils.randomID(),
        name: `${lodging.storageConfig.namingTemplate ?? ""}${n}`,
        storageTypeId,
        access: [{ actorId: receivingActorId, level: "primary" }],
        retrievalPolicyOverride: lodging.storageConfig.retrievalPolicyOverride ?? null
      };
      storageData.groups ??= [];
      storageData.groups.push(group);
      lodging.storageNextAreaNumber = n + 1;
      entry.storageGroupId = group.id;
    }
  }

  inn.ledger ??= [];
  inn.ledger.push(entry);
  return entry;
}

/**
 * Extend an existing booking by `additionalDurationSeconds` instead of creating a new one. If the
 * booking had already lapsed (reclaimed), re-consumes availability and un-reclaims it, extending from
 * `now` rather than the stale old expiry; otherwise extends from the booking's current expiry. If
 * access had been stripped by the expiry sweep (storageConfig.loseAccessOnExpiry), restores it.
 */
export function extendLodgingBooking(location, inn, entry, additionalDurationSeconds, now) {
  const wasLapsed = !!entry.reclaimed;
  if (wasLapsed) {
    consumeLodgingAvailability(inn, entry.lodgingId);
    entry.reclaimed = false;
  }

  const base = Math.max(entry.expiresAt ?? now, now);
  entry.durationSeconds = (entry.durationSeconds ?? 0) + additionalDurationSeconds;
  entry.expiresAt = base + additionalDurationSeconds;

  if (wasLapsed && entry.storageGroupId && inn.linkedStorageEntryId) {
    const lodging = (inn.lodgings ?? []).find(l => l.id === entry.lodgingId);
    if (lodging?.storageConfig?.loseAccessOnExpiry) {
      const storageData = location.typeData?.[inn.linkedStorageEntryId];
      const group = storageData?.groups?.find(g => g.id === entry.storageGroupId);
      if (group && !(group.access ?? []).some(a => a.actorId === entry.actorId)) {
        group.access = [...(group.access ?? []), { actorId: entry.actorId, level: "primary" }];
      }
    }
  }

  return entry;
}

/**
 * Ask whether a new booking conflicting with an existing one should get its own room, or extend the
 * existing booking instead. Resolves 'new' or 'extend' — including on close-without-choosing, since
 * by the time this is shown (after payment, or as the last step of manually adding a booking) there's
 * nothing left to safely cancel; 'new' is the pre-this-feature default behavior.
 */
export async function promptNewOrExtendLodging(lodgingName) {
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.lodgingConflict.title") },
    content: `<p>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.inn.lodgingConflict.body", { lodging: lodgingName })}</p>`,
    buttons: [
      { action: "new",    icon: "fa-solid fa-door-open",     label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.lodgingConflict.newRoom"), callback: () => "new" },
      { action: "extend", icon: "fa-solid fa-calendar-plus", label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.inn.lodgingConflict.extend"), default: true, callback: () => "extend" }
    ],
    rejectClose: false
  });
  return choice ?? "new";
}
