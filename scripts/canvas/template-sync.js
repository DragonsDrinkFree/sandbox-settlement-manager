import { MODULE_ID, FLAGS, LOCATION_TYPE_IDS, getTypeEntries } from "../constants.js";

function syncMerchantInventory(merchantData, templateMerchant) {
  const currentInventory  = merchantData.inventory  ?? [];
  const templateInventory = templateMerchant.inventory ?? [];

  const manualItems = currentInventory.filter(i => !i.templateItemId);

  const newInventory = [];
  for (const tItem of templateInventory) {
    const existing = currentInventory.find(i => i.templateItemId === tItem.id);
    if (existing) {
      const tv = existing._templateValues ?? null;
      const updated = { ...existing };

      const fieldDefs = [
        ["name",              ""],
        ["itemId",            null],
        ["minSettlementSize",       ""],
        ["stockAvailability", 100],
        ["stockFormula",      ""]
      ];
      for (const [f, def] of fieldDefs) {
        const tVal   = tItem[f] ?? def;
        const oldTpl = tv ? (tv[f] ?? def) : tVal;
        if (tv === null || existing[f] === oldTpl) updated[f] = tVal;
      }

      // Price: deep compare
      const tvPrice = tv?.price ?? null;
      if (tvPrice === null ||
          (existing.price?.currencyId === tvPrice.currencyId &&
           existing.price?.amount    === tvPrice.amount)) {
        updated.price = { ...(tItem.price ?? {}) };
      }

      updated._templateValues = {
        name:              tItem.name,
        itemId:            tItem.itemId            ?? null,
        minSettlementSize:       tItem.minSettlementSize       ?? "",
        stockAvailability: tItem.stockAvailability ?? 100,
        stockFormula:      tItem.stockFormula      ?? "",
        price:             { ...(tItem.price ?? {}) }
      };
      newInventory.push(updated);
    } else {
      newInventory.push({
        ...foundry.utils.deepClone(tItem),
        id:             foundry.utils.randomID(),
        templateItemId: tItem.id,
        quantity:       null,
        _templateValues: {
          name:              tItem.name,
          itemId:            tItem.itemId            ?? null,
          minSettlementSize:       tItem.minSettlementSize       ?? "",
          stockAvailability: tItem.stockAvailability ?? 100,
          stockFormula:      tItem.stockFormula      ?? "",
          price:             { ...(tItem.price ?? {}) }
        }
      });
    }
  }

  newInventory.push(...manualItems);

  const updated = { ...merchantData, inventory: newInventory };

  const tplSt = templateMerchant.stockType        ?? "percent";
  const tplRf = templateMerchant.restockFrequency ?? "weekly";

  if (merchantData._tplStockType        === undefined || merchantData.stockType        === merchantData._tplStockType)
    updated.stockType        = tplSt;
  if (merchantData._tplRestockFrequency === undefined || merchantData.restockFrequency === merchantData._tplRestockFrequency)
    updated.restockFrequency = tplRf;

  updated._tplStockType        = tplSt;
  updated._tplRestockFrequency = tplRf;

  return updated;
}

export async function syncNewTemplateItems(oldSubTypes, newSubTypes) {
  if (!game.user.isGM) return;

  const scenesData = [];
  for (const scene of game.scenes) {
    const locations = scene.getFlag(MODULE_ID, FLAGS.LOCATIONS);
    if (locations?.length) scenesData.push({ scene, locations: foundry.utils.deepClone(locations) });
  }
  if (!scenesData.length) return;

  // INN: add-only sync (existing behaviour)
  for (const newTemplate of (newSubTypes[LOCATION_TYPE_IDS.INN] ?? [])) {
    const oldTemplate   = (oldSubTypes[LOCATION_TYPE_IDS.INN] ?? []).find(t => t.id === newTemplate.id);
    const newLodgings   = newTemplate.typeData?.lodgings ?? [];
    const newCourses    = newTemplate.typeData?.menu?.courses ?? [];
    const oldLodgings   = oldTemplate?.typeData?.lodgings ?? [];
    const oldCourses    = oldTemplate?.typeData?.menu?.courses ?? [];
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
        const inn = location.typeData?.inn;
        if (!inn) continue;

        inn.lodgings ??= [];
        for (const tl of addedLodgings) {
          if (!inn.lodgings.some(l => l.templateItemId === tl.id)) {
            inn.lodgings.push({ ...foundry.utils.deepClone(tl), templateItemId: tl.id, overridden: false });
            dirty = true;
          }
        }

        inn.menu ??= { courses: [] };
        inn.menu.courses ??= [];
        for (const tc of addedCourses) {
          if (!inn.menu.courses.some(c => c.templateItemId === tc.id)) {
            inn.menu.courses.push({ ...foundry.utils.deepClone(tc), templateItemId: tc.id, overridden: false });
            dirty = true;
          }
        }
      }
      if (dirty) await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    }
  }

  // MERCHANT: full add/remove/change sync with field-level override tracking
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
        const currentMerchant = location.typeData?.merchant;
        if (!currentMerchant) continue;

        const syncedMerchant = syncMerchantInventory(currentMerchant, templateMerchant);
        if (JSON.stringify(currentMerchant) !== JSON.stringify(syncedMerchant)) {
          location.typeData.merchant = syncedMerchant;
          dirty = true;
        }
      }
      if (dirty) await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
    }
  }
}
