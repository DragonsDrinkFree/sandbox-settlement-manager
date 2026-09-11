// Stable "Contract" helpers — wage accrual, treasure-share options, term labels.
//
// Wage accrual is ADDITIVE (a flat wage each elapsed period), modelled on accrueStorageRent in
// rental-utils.js — NOT the compounding accrueLoan. It is a pure function used lazily/on-read only
// (ContractDetailsApp / ContractManagerApp recompute it every render); nothing writes owedStandard
// back except the initial-wage payment, which resets lastPaidAt/lastAccrualAt to "now". "Request
// Payment" is a stub, so owed simply grows from initiatedAt / last payment.

import { computeOwedCoins } from "./loan-utils.js";

/** Treasure-share option values, low → high. */
export const TREASURE_SHARES = ["1/4", "1/3", "1/2", "2/3", "full"];

/** Display label for a treasure-share value. */
export function treasureShareLabel(v) {
  return v === "full"
    ? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.stable.contract.fullShare")
    : (v ?? "—");
}

/** `[{ value, label, selected }]` for a treasure-share <select>. */
export function treasureShareOptions(selected) {
  return TREASURE_SHARES.map(v => ({ value: v, label: treasureShareLabel(v), selected: v === selected }));
}

/** Display label for a contract-terms value ("wages" | "treasure" | "both"). */
export function contractTermsLabel(terms) {
  return game.i18n.localize(`SANDBOX_SETTLEMENT_MANAGER.stable.contract.terms.${terms ?? "wages"}`);
}

/** Coin breakdown for an owed standard-currency amount (rounds up to the smallest denomination). */
export function contractOwedCoins(owedStandard, currencies) {
  return computeOwedCoins(owedStandard, currencies);
}

/**
 * Pure. Add one wage per full elapsed period to `owedStandard`, advancing `lastAccrualAt` by whole
 * periods only. No-op for treasure-only contracts, non-active contracts, a zero/absent period, or
 * when less than one full period has elapsed. Returns a new object only when it changes something.
 */
export function accrueContract(contract, now) {
  if (!contract || contract.status !== "active") return contract;
  if (!(contract.contractTerms === "wages" || contract.contractTerms === "both")) return contract;
  const ps = contract.periodSeconds;
  if (!ps || ps <= 0) return contract;
  const periods = Math.floor((now - (contract.lastAccrualAt ?? now)) / ps);
  if (periods <= 0) return contract;
  return {
    ...contract,
    owedStandard:  (contract.owedStandard ?? 0) + (contract.wagePerPeriodStandard ?? 0) * periods,
    lastAccrualAt: (contract.lastAccrualAt ?? now) + periods * ps
  };
}
