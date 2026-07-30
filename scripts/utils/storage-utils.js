// Pure logic shared by location-data.js (Storage tab display) and the two location-rendering
// apps' action handlers (deposit/take/ownership mutations), so eligibility and capacity rules
// live in exactly one place. No game.* calls beyond readItemWeight()'s settings read.

import { readItemWeight } from "./item-utils.js";

/** Weight of a stored stack: per-unit weight (via the configured weightAttribute) × quantity. */
export function computeItemWeight(itemData, quantity) {
  return readItemWeight(itemData) * (quantity ?? 1);
}

/** Total weight currently stored in a given group. */
export function computeGroupUsedWeight(items, groupId) {
  return (items ?? [])
    .filter(i => i.groupId === groupId)
    .reduce((sum, i) => sum + computeItemWeight(i.itemData, i.quantity), 0);
}

/** A group's retrieval policy, falling back to its storage type's default when unset. */
export function resolveEffectivePolicy(group, storageType) {
  return group?.retrievalPolicyOverride ?? storageType?.retrievalPolicy ?? "depositorOnly";
}

/** True if the given actor is on the group's access list. */
export function actorHasGroupAccess(group, actorId) {
  return (group?.accessActorIds ?? []).includes(actorId);
}

/**
 * Whether `actorId` may retrieve a given stored item:
 *   1. The depositor can always take their own item back.
 *   2. An item explicitly assigned to this actor can be taken by them.
 *   3. An item marked "group property" can be taken by anyone with group access.
 *   4. Otherwise, only if the effective policy is "anyone" and the actor has group access.
 */
export function canRetrieve(item, group, storageType, actorId) {
  if (!item || !actorId) return false;
  if (item.depositedByActorId === actorId) return true;
  const ownership = item.ownership ?? { mode: "private" };
  if (ownership.mode === "assigned") return ownership.assignedToActorId === actorId;
  if (ownership.mode === "group") return actorHasGroupAccess(group, actorId);
  return resolveEffectivePolicy(group, storageType) === "anyone" && actorHasGroupAccess(group, actorId);
}

/** Whether adding `addedWeight` to a group already holding `currentUsedWeight` would exceed its storage type's limit. */
export function wouldExceedCapacity(storageType, currentUsedWeight, addedWeight) {
  return storageType?.weightLimit !== null && storageType?.weightLimit !== undefined
    && (currentUsedWeight + addedWeight) > storageType.weightLimit;
}
