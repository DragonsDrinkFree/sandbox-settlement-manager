import { costInStandard } from "./currency-utils.js";
import { LOAN_PERIOD_DAYS } from "./loan-utils.js";

/** Rental period units, shortest first. */
const PERIOD_ORDER = ["day", "week", "month"];

/** Round a derived price to whole hundredths — the step the price inputs use. */
const roundPrice = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Resolve a Bank storage rental option to its three concrete rates plus its minimum period.
 *
 * A null pricePerWeek/pricePerMonth means "auto-derive" — the same null-means-auto convention the
 * Inn's lodgings use for pricePerWeek. Derivation cascades down the ladder: the week follows the
 * day, and the month follows the *week*, so a manually-set weekly discount carries into a derived
 * month instead of being silently ignored. When the week is itself derived the chain collapses to
 * day x 30, i.e. deriving straight from the day price.
 *
 * The multipliers are LOAN_PERIOD_DAYS (7 and 30) rather than the world's daysPerWeek, because a
 * rental's *duration* comes from periodSecondsFor, which uses that same fixed ladder; deriving the
 * price from a different day count than the duration would silently under- or over-charge.
 */
export function resolveRentalPricing(option) {
  const day = option?.pricePerDay ?? { currencyId: "", amount: 0 };
  // Kept unrounded so a fully-linked chain lands on day x 30 exactly — only the exposed value is
  // rounded, never the base the next tier derives from.
  const weekRaw  = option?.pricePerWeek?.amount     ?? (day.amount ?? 0) * LOAN_PERIOD_DAYS.week;
  const weekCurr = option?.pricePerWeek?.currencyId ?? day.currencyId;
  return {
    day,
    week:  option?.pricePerWeek ?? { currencyId: weekCurr, amount: roundPrice(weekRaw) },
    month: option?.pricePerMonth ?? {
      currencyId: weekCurr,
      amount: roundPrice(weekRaw * (LOAN_PERIOD_DAYS.month / LOAN_PERIOD_DAYS.week))
    },
    minPeriodUnit: PERIOD_ORDER.includes(option?.minPeriodUnit) ? option.minPeriodUnit : "day"
  };
}

/** Period units a renter may choose for this option — those at or above its minimum. */
export function availablePeriodUnits(minPeriodUnit) {
  const i = PERIOD_ORDER.indexOf(minPeriodUnit);
  return PERIOD_ORDER.slice(i === -1 ? 0 : i);
}

/**
 * Advance a delinquent Bank storage rental's owed balance by one charge per full elapsed period
 * since lastAccrualAt. Additive (a flat recurring charge), not compounding like loan interest.
 * Rent is prepaid, so the period that just lapsed at the active→delinquent transition is charged
 * immediately by reclaimExpiredStorageRentals below — this only bills any *further* full periods
 * that elapse after that. Pure: returns a new rental object (or the same reference when nothing
 * changed). Used both for on-read display and for server-authoritative mutation before a payment
 * is applied.
 */
export function accrueStorageRent(rental, now, feeStandard) {
  if (!rental || rental.status !== "delinquent") return rental;
  const periodSeconds = rental.periodSeconds;
  if (!periodSeconds || periodSeconds <= 0) return rental;
  const elapsed = now - (rental.lastAccrualAt ?? now);
  const periods = Math.floor(elapsed / periodSeconds);
  if (periods <= 0) return rental;
  return {
    ...rental,
    owedStandard:  (rental.owedStandard ?? 0) + feeStandard * periods,
    lastAccrualAt: (rental.lastAccrualAt ?? now) + periods * periodSeconds
  };
}

/**
 * Sweep a Bank's rentals for ones whose paid-through date has passed: an empty Storage Area (and
 * its rental record) is destroyed outright; an occupied Area has the renter's access revoked and
 * the rental flips to delinquent so accrueStorageRent starts charging. Since rent is prepaid, the
 * period that just lapsed was never paid for — it's charged immediately here rather than waiting
 * for a further full period to elapse (accrueStorageRent only bills periods *after* this one).
 * Mutates `bank.rentals` and the linked Storage entry's groups in place. Returns true if anything
 * changed.
 */
export function reclaimExpiredStorageRentals(location, bank, now, currencies) {
  let changed = false;
  const kept = [];
  for (const rental of (bank.rentals ?? [])) {
    if (rental.status !== "active" || (rental.paidThroughAt ?? Infinity) > now) { kept.push(rental); continue; }
    changed = true;
    const storageData = location.typeData?.[bank.linkedStorageEntryId];
    const group = storageData?.groups?.find(g => g.id === rental.groupId);
    const itemCount = group ? (storageData.items ?? []).filter(i => i.groupId === group.id).length : 0;
    if (!group || itemCount === 0) {
      if (storageData && group) storageData.groups = storageData.groups.filter(g => g.id !== group.id);
      continue; // empty — drop the rental record too, nothing left to protect
    }
    group.access = (group.access ?? []).filter(a => a.actorId !== rental.actorId);
    const feeStandard = costInStandard({ currencyId: rental.feeCurrencyId, amount: rental.feeAmount }, currencies ?? []);
    rental.status = "delinquent";
    rental.owedStandard = (rental.owedStandard ?? 0) + feeStandard;
    rental.lastAccrualAt = rental.paidThroughAt;
    kept.push(rental);
  }
  bank.rentals = kept;
  return changed;
}
