import { MODULE_ID, SETTINGS, LOCATION_TYPE_IDS, getTypeEntries } from "../constants.js";
import { readItemPrice } from "../utils/item-utils.js";

/**
 * Merge the purchasing profiles of every merchant tab at a location into the effective rule set that
 * drives the derived Sell tab. Each merchant entry owns its own `purchasingProfile` (a per-tab
 * "single-use template"); entries saved before per-entry profiles existed fall back to their source
 * template's profile.
 *
 * Returns an array of effective rules, each annotated with:
 *   _source: "template" | "conflict"
 *   _conflicted: boolean — true if two merchant tabs disagreed on buyRate
 *   _buybackConflicted: boolean — true if two merchant tabs disagreed on buybackType
 */
export function mergePurchasingProfiles(location) {
  const entries      = getTypeEntries(location).filter(e => e.typeId === LOCATION_TYPE_IDS.MERCHANT);
  const subTypeMap   = game.settings.get(MODULE_ID, SETTINGS.LOCATION_TYPES) ?? {};
  const merchantList = Array.isArray(subTypeMap) ? [] : (subTypeMap[LOCATION_TYPE_IDS.MERCHANT] ?? []);

  // Collect each merchant tab's own rules grouped by itemType.
  const byType = new Map(); // itemType → [rule, ...]
  for (const entry of entries) {
    let profile = location.typeData?.[entry.id]?.purchasingProfile;
    if (!profile) {
      const template = entry.subTypeId ? merchantList.find(t => t.id === entry.subTypeId) : null;
      profile = template?.typeData?.merchant?.purchasingProfile ?? [];
    }
    for (const rule of profile) {
      if (!byType.has(rule.itemType)) byType.set(rule.itemType, []);
      // Resolve the effective buy rate to the per-restock rolled value (falling back to the
      // configured min when a merchant hasn't rolled yet). Downstream code reads `buyRate`.
      byType.get(rule.itemType).push({ ...rule, buyRate: rule._rolledBuyRate ?? rule.buyRate });
    }
  }

  const effectiveRules = [];
  for (const [itemType, rules] of byType) {
    if (rules.length === 1) {
      effectiveRules.push({ ...rules[0], _source: "template", _conflicted: false, _buybackConflicted: false });
    } else {
      const lowestRate = Math.min(...rules.map(r => r.buyRate ?? 0));
      const allSameBuyback = rules.every(r => r.buybackType === rules[0].buybackType);
      effectiveRules.push({
        ...rules[0],
        buyRate: lowestRate,
        _source:            "conflict",
        _conflicted:        true,
        _buybackConflicted: !allSameBuyback,
        _conflictingRules:  rules
      });
    }
  }

  return effectiveRules;
}

/**
 * Find the effective purchasing rule for a given Foundry item type string.
 * Falls back to the "" catch-all rule if no specific rule matches.
 */
export function findEffectiveRule(effectiveRules, itemType) {
  return effectiveRules.find(r => r.itemType === itemType)
      ?? effectiveRules.find(r => r.itemType === "")
      ?? null;
}

/**
 * Compute the sale price for an actor item given a purchasing rule.
 * Returns { amount, currencyId } or null if the item has no price.
 */
export function computeSalePrice(actorItem, effectiveRule, currencies) {
  if (!effectiveRule || (effectiveRule.buyRate ?? 0) <= 0) return null;
  const listPrice = readItemPrice(actorItem, currencies);
  if (!listPrice || !listPrice.amount) return null;
  const amount = Math.max(1, Math.round(listPrice.amount * effectiveRule.buyRate / 100));
  return { amount, currencyId: listPrice.currencyId };
}

