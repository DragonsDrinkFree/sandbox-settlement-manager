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

/**
 * Normalizes a group's access list to the current shape (`[{ actorId, level }]`, level is
 * "primary" | "guest"). Legacy groups only have a flat `accessActorIds` array — those members
 * become "primary" entries (safest default: preserves their existing full standing rather than
 * silently demoting them the first time this reads old data).
 */
export function getGroupAccessList(group) {
  if (Array.isArray(group?.access)) return group.access;
  return (group?.accessActorIds ?? []).map(actorId => ({ actorId, level: "primary" }));
}

/** True if the given actor is on the group's access list (either level). */
export function actorHasGroupAccess(group, actorId) {
  return getGroupAccessList(group).some(a => a.actorId === actorId);
}

/** True if any of the given actor IDs (the current user's owned actors) holds Primary level in this group. */
export function canManageGuests(group, myActorIds) {
  return getGroupAccessList(group).some(a => a.level === "primary" && myActorIds.includes(a.actorId));
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

/**
 * Resolve a *template* Storage Type id (the only kind available where Inn lodgings/Bank rental
 * options are configured, since a shared template can be attached to many Locations) into the
 * matching *instance* Storage Type on one specific attached Storage entry. Template and instance
 * ids always differ — each attachment gets its own fresh clone via instanceFromTemplate — so this
 * bridges them via the templateItemId that clone stamps. Returns null if no matching instance
 * exists yet (e.g. the Storage Type was added to the template after this Location's Storage entry
 * was last synced).
 */
export function resolveInstanceStorageType(instanceStorageTypes, templateStorageTypeId) {
  if (!templateStorageTypeId) return null;
  return (instanceStorageTypes ?? []).find(st => st.templateItemId === templateStorageTypeId) ?? null;
}

/** Whether adding `addedWeight` to a group already holding `currentUsedWeight` would exceed its storage type's limit. */
export function wouldExceedCapacity(storageType, currentUsedWeight, addedWeight) {
  return storageType?.weightLimit !== null && storageType?.weightLimit !== undefined
    && (currentUsedWeight + addedWeight) > storageType.weightLimit;
}

/** Fields that legitimately differ between two document instances of "the same" item; never divergence. */
const STACK_IGNORE_KEYS = ["_id", "sort", "folder", "ownership", "_stats", "flags"];

/**
 * Best-effort check for whether two item data snapshots are the same "kind" of item and could safely
 * share a stack. Not a guarantee for arbitrary game systems — callers should treat `false` as "don't
 * merge, fall back to creating a separate stack," never as a reason to block the action.
 */
export function itemsMatchForStacking(a, b) {
  if (!a || !b) return false;
  if (a.name !== b.name || a.type !== b.type || a.img !== b.img) return false;
  const normalize = (obj) => {
    const clone = foundry.utils.deepClone(obj);
    for (const key of STACK_IGNORE_KEYS) delete clone[key];
    foundry.utils.setProperty(clone, "system.quantity", undefined);
    return clone;
  };
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Find a live item already on `actor` that `itemData` could stack onto (Take side). */
export function findMatchingActorItem(actor, itemData) {
  return actor.items.find(i => itemsMatchForStacking(i.toObject(), itemData)) ?? null;
}

/** Find an existing stored entry in the same group, deposited by the same actor, matching `itemData` (Deposit side). */
export function findMatchingStoredItem(items, groupId, depositedByActorId, itemData) {
  return (items ?? []).find(i =>
    i.groupId === groupId &&
    i.depositedByActorId === depositedByActorId &&
    itemsMatchForStacking(i.itemData, itemData)
  ) ?? null;
}
