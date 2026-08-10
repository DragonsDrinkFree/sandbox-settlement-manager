/**
 * Inn lodging availability helpers, shared by the world-time expiry processor and the manual
 * dismiss handlers. Pure functions over a plain inn object (`{ lodgings, ledger }`) with no imports,
 * so they can be used from anywhere without creating module cycles.
 *
 * Availability semantics mirror merchant stock: a number is tracked stock; null/blank is infinite
 * (never decremented, restored, or blocked). Each booking consumes exactly one unit.
 */

/**
 * Restore one unit of availability for the lodging referenced by a booking ledger entry.
 * No-op (returns false) when the lodging is gone or its availability is infinite (non-numeric).
 */
export function restoreLodgingAvailability(inn, entry) {
  if (!inn || !entry?.lodgingId) return false;
  const lodging = (inn.lodgings ?? []).find(l => l.id === entry.lodgingId);
  if (lodging && typeof lodging.availability === "number") {
    lodging.availability += 1;
    return true;
  }
  return false;
}

/**
 * Consume one unit of availability for the given lodging (the inverse of
 * restoreLodgingAvailability). No-op (returns false) when the lodging is gone or its availability
 * is infinite (non-numeric). Clamped at 0 — never goes negative, so a GM can still force-add a
 * booking to an already sold-out room.
 */
export function consumeLodgingAvailability(inn, lodgingId) {
  if (!inn || !lodgingId) return false;
  const lodging = (inn.lodgings ?? []).find(l => l.id === lodgingId);
  if (lodging && typeof lodging.availability === "number") {
    lodging.availability = Math.max(0, lodging.availability - 1);
    return true;
  }
  return false;
}

/**
 * Restore availability for every booking that has expired (`expiresAt <= now`) and not yet been
 * reclaimed, marking each `reclaimed` so it only restores once. The entry itself is kept (shown as
 * expired) until a GM dismisses it. If the booking's lodging row has storage configured with
 * "loses access on expiry" checked, also strips that renter from the linked Storage Area's access
 * list (the Area itself is never deleted — only that one actor's access entry is removed). Mutates
 * `inn` (and, when access is stripped, the Storage entry on `location`); returns true if anything
 * changed. `location` is only used to resolve the linked Storage entry — pass null to skip the
 * access-strip step (e.g. if the caller doesn't have the whole Location handy).
 */
export function reclaimExpiredBookings(location, inn, now) {
  let changed = false;
  for (const entry of (inn?.ledger ?? [])) {
    if (entry.reclaimed) continue;
    if ((entry.expiresAt ?? Infinity) > now) continue;
    restoreLodgingAvailability(inn, entry);
    entry.reclaimed = true;
    changed = true;

    if (location && entry.storageGroupId && inn.linkedStorageEntryId) {
      const lodging = (inn.lodgings ?? []).find(l => l.id === entry.lodgingId);
      if (lodging?.storageConfig?.loseAccessOnExpiry) {
        const storageData = location.typeData?.[inn.linkedStorageEntryId];
        const group = storageData?.groups?.find(g => g.id === entry.storageGroupId);
        if (group) group.access = (group.access ?? []).filter(a => a.actorId !== entry.actorId);
      }
    }
  }
  return changed;
}
