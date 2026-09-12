// Stable "Contract" helpers — wage accrual, treasure-share options, term labels.
//
// Wage accrual is ADDITIVE (a flat wage each elapsed period), modelled on accrueStorageRent in
// rental-utils.js — NOT the compounding accrueLoan. It is a pure function used lazily/on-read only
// (ContractDetailsApp / ContractManagerApp recompute it every render). Wages are paid up front, so
// a wage-bearing contract's owedStandard starts at one period's wage (see
// socket.js#_handleProposeStableContract) rather than 0 — nothing writes it back to 0 except a
// successful initial-wage payment (socket.js#_handleStableContractResolved), which also resets
// lastPaidAt/lastAccrualAt to "now". If that payment never happens (e.g. the proposer was offline),
// the up-front wage correctly stays owed. "Request Payment" is a stub, so owed simply keeps growing
// from there.

import { computeOwedCoins, periodSecondsFor } from "./loan-utils.js";
import { costInStandard } from "./currency-utils.js";

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
 * Build a fresh contract record — the single source of truth for the shape shared by every way a
 * contract can come into being (negotiated-and-accepted via socket.js#_handleProposeStableContract,
 * or hand-authored via ContractManagerApp's "+ New Contract"). `sceneId`/`locationId`/`locationName`/
 * `entryId`/`listingId` default to null/"" for contracts with no Stable-listing origin (manual
 * creation) — contract-details.hbs already guards `{{#if locationName}}` so that row just disappears.
 */
export function buildContractRecord({
  contractTerms, sourceActorName, sourceActorUuid, hiringActorId, hiringActorName,
  sceneId = null, locationId = null, locationName = "", entryId = null, listingId = null,
  wageAmount = 0, wageCurrencyId = "", wagePeriod = "week", treasureShare = null,
  currencies, hoursPerDay, now
}) {
  const wantsWage = contractTerms === "wages" || contractTerms === "both";
  const wantsTreasure = contractTerms === "treasure" || contractTerms === "both";
  const wp = ["day", "week", "month"].includes(wagePeriod) ? wagePeriod : "week";
  const wageCoins = wantsWage && wageCurrencyId ? { [wageCurrencyId]: Math.max(0, wageAmount || 0) } : {};
  const wagePerPeriodStandard = wantsWage
    ? costInStandard({ currencyId: wageCurrencyId, amount: Math.max(0, wageAmount || 0) }, currencies)
    : 0;
  return {
    id: foundry.utils.randomID(), contractTerms,
    sourceActorName, sourceActorUuid, hiringActorId, hiringActorName,
    sceneId, locationId, locationName, entryId, listingId,
    wageAmount: wantsWage ? Math.max(0, wageAmount || 0) : 0,
    wageCurrencyId: wantsWage ? (wageCurrencyId ?? "") : "",
    wageCoins, wagePerPeriodStandard, wagePeriod: wp,
    periodSeconds: periodSecondsFor(wp, hoursPerDay * 3600),
    treasureShare: wantsTreasure ? (treasureShare ?? "1/2") : null,
    initiatedAt: now, lastPaidAt: now, lastAccrualAt: now,
    // Wages are paid up front — see the module comment at the top of this file.
    owedStandard: wantsWage ? wagePerPeriodStandard : 0,
    gmNotes: "", status: "active"
  };
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
