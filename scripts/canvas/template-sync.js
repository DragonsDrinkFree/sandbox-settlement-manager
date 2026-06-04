import { MODULE_ID, FLAGS, RESOURCE_TYPE_IDS, getTypeEntries } from "../constants.js";

export async function syncNewTemplateItems(oldSubTypes, newSubTypes) {
  if (!game.user.isGM) return;

  const scenesData = [];
  for (const scene of game.scenes) {
    const resources = scene.getFlag(MODULE_ID, FLAGS.RESOURCES);
    if (resources?.length) scenesData.push({ scene, resources: foundry.utils.deepClone(resources) });
  }
  if (!scenesData.length) return;

  for (const typeId of [RESOURCE_TYPE_IDS.INN]) {
    for (const newTemplate of (newSubTypes[typeId] ?? [])) {
      const oldTemplate   = (oldSubTypes[typeId] ?? []).find(t => t.id === newTemplate.id);
      const newLodgings   = newTemplate.typeData?.lodgings ?? [];
      const newCourses    = newTemplate.typeData?.menu?.courses ?? [];
      const oldLodgings   = oldTemplate?.typeData?.lodgings ?? [];
      const oldCourses    = oldTemplate?.typeData?.menu?.courses ?? [];
      const addedLodgings = newLodgings.filter(l => !oldLodgings.some(ol => ol.id === l.id));
      const addedCourses  = newCourses.filter(c => !oldCourses.some(oc => oc.id === c.id));
      if (!addedLodgings.length && !addedCourses.length) continue;

      for (const { scene, resources } of scenesData) {
        let dirty = false;
        for (const resource of resources) {
          const entry = getTypeEntries(resource).find(
            e => e.typeId === typeId && e.subTypeId === newTemplate.id
          );
          if (!entry) continue;
          const inn = resource.typeData?.inn;
          if (!inn) continue;

          inn.lodgings ??= [];
          for (const tl of addedLodgings) {
            if (!inn.lodgings.some(l => l.templateItemId === tl.id)) {
              inn.lodgings.push({
                ...foundry.utils.deepClone(tl),
                templateItemId: tl.id,
                overridden:     false
              });
              dirty = true;
            }
          }

          inn.menu ??= { courses: [] };
          inn.menu.courses ??= [];
          for (const tc of addedCourses) {
            if (!inn.menu.courses.some(c => c.templateItemId === tc.id)) {
              inn.menu.courses.push({
                ...foundry.utils.deepClone(tc),
                templateItemId: tc.id,
                overridden:     false
              });
              dirty = true;
            }
          }
        }
        if (dirty) await scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
      }
    }
  }
}
