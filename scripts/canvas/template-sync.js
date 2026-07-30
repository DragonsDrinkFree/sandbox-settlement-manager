import { MODULE_ID, FLAGS, LOCATION_TYPE_IDS, getTypeEntries } from "../constants.js";
import { syncCollection, TEMPLATE_FIELDS } from "./template-link.js";

/** Full-sync a merchant instance against its template: inventory items + merchant-level stock settings. */
function syncMerchant(merchantData, templateMerchant) {
  const inventory = syncCollection(
    merchantData.inventory ?? [],
    templateMerchant.inventory ?? [],
    TEMPLATE_FIELDS.merchantItem,
    { mode: "full", newDefaults: { quantity: null } }
  );
  const updated = { ...merchantData, inventory };

  // Merchant-level stock settings: adopt the template value unless the instance overrode it.
  const tplSt = templateMerchant.stockType        ?? "percent";
  const tplRf = templateMerchant.restockFrequency ?? "weekly";
  if (merchantData._tplStockType        === undefined || merchantData.stockType        === merchantData._tplStockType)
    updated.stockType        = tplSt;
  if (merchantData._tplRestockFrequency === undefined || merchantData.restockFrequency === merchantData._tplRestockFrequency)
    updated.restockFrequency = tplRf;
  updated._tplStockType        = tplSt;
  updated._tplRestockFrequency = tplRf;

  // Price-variation settings: same adopt-unless-overridden pattern (shadow field per setting).
  const priceVarDefaults = { priceVarMin: 0, priceVarMax: 0, priceVarIndividual: false, priceVarRounding: "same" };
  for (const [field, dflt] of Object.entries(priceVarDefaults)) {
    const shadow = `_tpl${field.charAt(0).toUpperCase()}${field.slice(1)}`;
    const tplVal = templateMerchant[field] ?? dflt;
    if (merchantData[shadow] === undefined || merchantData[field] === merchantData[shadow])
      updated[field] = tplVal;
    updated[shadow] = tplVal;
  }
  return updated;
}

/** Full-sync a storage instance's storageTypes against its template. Groups/items are untouched. */
function syncStorage(storageData, templateStorage) {
  const storageTypes = syncCollection(
    storageData.storageTypes ?? [],
    templateStorage.storageTypes ?? [],
    TEMPLATE_FIELDS.storageType,
    { mode: "full" }
  );
  return { ...storageData, storageTypes };
}

export async function syncNewTemplateItems(oldSubTypes, newSubTypes) {
  if (!game.user.isGM) return;

  const scenesData = [];
  for (const scene of game.scenes) {
    const locations = scene.getFlag(MODULE_ID, FLAGS.LOCATIONS);
    if (locations?.length) scenesData.push({ scene, locations: foundry.utils.deepClone(locations) });
  }
  if (!scenesData.length) return;

  // INN: add-only sync — append instances for lodgings/courses newly added to the template.
  for (const newTemplate of (newSubTypes[LOCATION_TYPE_IDS.INN] ?? [])) {
    const oldTemplate = (oldSubTypes[LOCATION_TYPE_IDS.INN] ?? []).find(t => t.id === newTemplate.id);
    const newLodgings = newTemplate.typeData?.lodgings ?? [];
    const newCourses  = newTemplate.typeData?.menu?.courses ?? [];
    const oldLodgings = oldTemplate?.typeData?.lodgings ?? [];
    const oldCourses  = oldTemplate?.typeData?.menu?.courses ?? [];
    const addedLodgings = newLodgings.filter(l => !oldLodgings.some(ol => ol.id === l.id));
    const addedCourses  = newCourses.filter(c => !oldCourses.some(oc => oc.id === c.id));
    if (!addedLodgings.length && !addedCourses.length) continue;

    for (const { scene, locations } of scenesData) {
      let dirty = false;
      for (const location of locations) {
        const entry = getTypeEntries(location).find(
          e => e.typeId === LOCATION_TYPE_IDS.INN && e.subTypeId === newTemplate.id
        );
        if (!entry) continue;
        const inn = location.typeData?.[entry.id];
        if (!inn) continue;

        if (addedLodgings.length) {
          inn.lodgings = syncCollection(inn.lodgings ?? [], addedLodgings, TEMPLATE_FIELDS.lodging, { mode: "add" });
          dirty = true;
        }
        if (addedCourses.length) {
          inn.menu ??= { courses: [] };
          inn.menu.courses = syncCollection(inn.menu.courses ?? [], addedCourses, TEMPLATE_FIELDS.course, { mode: "add" });
          dirty = true;
        }
      }
      if (dirty) await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    }
  }

  // MERCHANT: full add/remove/change sync with field-level override tracking.
  for (const newTemplate of (newSubTypes[LOCATION_TYPE_IDS.MERCHANT] ?? [])) {
    const templateMerchant = newTemplate.typeData?.merchant;
    if (!templateMerchant) continue;

    for (const { scene, locations } of scenesData) {
      let dirty = false;
      for (const location of locations) {
        const entry = getTypeEntries(location).find(
          e => e.typeId === LOCATION_TYPE_IDS.MERCHANT && e.subTypeId === newTemplate.id
        );
        if (!entry) continue;
        const currentMerchant = location.typeData?.[entry.id];
        if (!currentMerchant) continue;

        const syncedMerchant = syncMerchant(currentMerchant, templateMerchant);
        if (JSON.stringify(currentMerchant) !== JSON.stringify(syncedMerchant)) {
          location.typeData[entry.id] = syncedMerchant;
          dirty = true;
        }
      }
      if (dirty) await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    }
  }

  // STORAGE: full sync of storageTypes (groups/items are instance-only, never touched here).
  for (const newTemplate of (newSubTypes[LOCATION_TYPE_IDS.STORAGE] ?? [])) {
    const templateStorage = newTemplate.typeData?.storage;
    if (!templateStorage) continue;

    for (const { scene, locations } of scenesData) {
      let dirty = false;
      for (const location of locations) {
        const entry = getTypeEntries(location).find(
          e => e.typeId === LOCATION_TYPE_IDS.STORAGE && e.subTypeId === newTemplate.id
        );
        if (!entry) continue;
        const currentStorage = location.typeData?.[entry.id];
        if (!currentStorage) continue;

        const syncedStorage = syncStorage(currentStorage, templateStorage);
        if (JSON.stringify(currentStorage) !== JSON.stringify(syncedStorage)) {
          location.typeData[entry.id] = syncedStorage;
          dirty = true;
        }
      }
      if (dirty) await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    }
  }
}
