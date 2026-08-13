// Unified template→instance override model.
//
// A "linked" instance record carries:
//   templateItemId   — id of the template item it was stamped from
//   _templateValues  — snapshot of the template-authored fields at link/sync time
//
// Divergence ("overridden") is auto-detected by comparing the instance's current field values
// against its snapshot — no manual `overridden` flag. Used by Inn lodgings/courses, Merchant
// inventory, and Bank settings (a single linked record).

/** Template-authored field lists per linked record type (runtime-only fields excluded). */
export const TEMPLATE_FIELDS = {
  lodging:      ["name", "beds", "availability", "pricePerDay", "pricePerWeek", "autoWeekly", "storageConfig"],
  course:       ["name", "mode", "price", "drawCount", "drawCountMin", "drawCountMax", "refreshCadence", "items", "pool", "priceVarMin", "priceVarMax", "priceVarIndividual", "priceVarRounding"],
  merchantItem: ["name", "itemId", "minSettlementSize", "stockAvailability", "stockFormula", "price"],
  bank:         ["doesExchange", "exchangeFee", "depositSettings"],
  storageType:  ["name", "weightLimit", "retrievalPolicy"],
  storageRentalOption: ["storageTypeId", "pricePerDay", "pricePerWeek", "pricePerMonth", "minPeriodUnit", "namingTemplate"]
};

/** Order-agnostic deep equality for primitives, arrays, and plain objects. */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(k => valuesEqual(a[k], b[k]));
  }
  return false;
}

/** Snapshot the given template-authored fields from a template item. */
export function snapshot(templateItem, fields) {
  const snap = {};
  for (const f of fields) snap[f] = foundry.utils.deepClone(templateItem?.[f] ?? null);
  return snap;
}

/** Create a fresh linked instance from a template item: full clone + new id + link + snapshot. */
export function instanceFromTemplate(templateItem, fields, extra = {}) {
  return {
    ...foundry.utils.deepClone(templateItem),
    id:             foundry.utils.randomID(),
    templateItemId: templateItem.id,
    _templateValues: snapshot(templateItem, fields),
    ...extra
  };
}

/** Field names where the instance currently diverges from its snapshot. Empty if unlinked/unsnapshotted. */
export function diffFields(instance, fields) {
  const tv = instance?._templateValues;
  if (!tv) return [];
  return fields.filter(f => !valuesEqual(instance[f], tv[f]));
}

/** True if any template-authored field diverges from the snapshot. */
export function isOverridden(instance, fields) {
  return diffFields(instance, fields).length > 0;
}

/** Reset the instance's template-authored fields to the template and refresh its snapshot. */
export function restoreFields(instance, templateItem, fields) {
  for (const f of fields) instance[f] = foundry.utils.deepClone(templateItem?.[f] ?? null);
  instance._templateValues = snapshot(templateItem, fields);
  return instance;
}

/**
 * Reconcile a collection of linked instances against a template list.
 *  - mode "add": purely additive — append a new linked instance for any template item that has no
 *    instance yet; existing instances and order are untouched. Pass only the *newly-added* template
 *    items so user-deleted items aren't re-added.
 *  - mode "full": rebuild from the full template list — drop instances whose template item was
 *    removed, append new ones, and for surviving instances adopt the new template value of any field
 *    the instance has NOT overridden (still equals its old snapshot). Snapshots are refreshed.
 * Manual (unlinked) instances are always preserved.
 *
 * @returns {Array} the reconciled instance array (new array).
 */
export function syncCollection(instances, templates, fields, { mode = "full", newDefaults = {} } = {}) {
  instances = instances ?? [];
  templates = templates ?? [];

  if (mode === "add") {
    const result = [...instances];
    for (const t of templates) {
      if (!instances.some(i => i.templateItemId === t.id)) {
        result.push(instanceFromTemplate(t, fields, newDefaults));
      }
    }
    return result;
  }

  // full sync
  const manual = instances.filter(i => !i.templateItemId);
  const result = [];
  for (const t of templates) {
    const existing = instances.find(i => i.templateItemId === t.id);
    if (!existing) { result.push(instanceFromTemplate(t, fields, newDefaults)); continue; }
    const tv = existing._templateValues ?? null;
    const updated = { ...existing };
    for (const f of fields) {
      const oldTpl = tv ? tv[f] : t[f];
      if (tv === null || valuesEqual(existing[f], oldTpl)) updated[f] = foundry.utils.deepClone(t[f] ?? null);
    }
    updated._templateValues = snapshot(t, fields);
    result.push(updated);
  }
  result.push(...manual);
  return result;
}
