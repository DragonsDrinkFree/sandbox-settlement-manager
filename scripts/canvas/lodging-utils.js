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
 * Restore availability for every booking that has expired (`expiresAt <= now`) and not yet been
 * reclaimed, marking each `reclaimed` so it only restores once. The entry itself is kept (shown as
 * expired) until a GM dismisses it. Mutates `inn`; returns true if anything changed.
 */
export function reclaimExpiredBookings(inn, now) {
  let changed = false;
  for (const entry of (inn?.ledger ?? [])) {
    if (entry.reclaimed) continue;
    if ((entry.expiresAt ?? Infinity) > now) continue;
    restoreLodgingAvailability(inn, entry);
    entry.reclaimed = true;
    changed = true;
  }
  return changed;
}
