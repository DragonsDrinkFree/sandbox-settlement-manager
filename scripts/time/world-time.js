import { MODULE_ID, SETTINGS, FLAGS, LOCATION_TYPE_IDS, getTypeEntries } from "../constants.js";
import { reclaimExpiredBookings } from "../canvas/lodging-utils.js";
import { reclaimExpiredStorageRentals } from "../utils/rental-utils.js";

export function getWorldTimeConfig() {
  return {
    hoursPerDay: game.settings.get(MODULE_ID, SETTINGS.HOURS_PER_DAY),
    daysPerWeek: game.settings.get(MODULE_ID, SETTINGS.DAYS_PER_WEEK)
  };
}

/**
 * Convert absolute world-time seconds into structured game-calendar components.
 * All values are 0-indexed. dayOfWeek resets each week; totalDays keeps counting.
 */
export function secondsToComponents(totalSeconds) {
  const { hoursPerDay, daysPerWeek } = getWorldTimeConfig();
  const secondsPerHour = 3600;
  const secondsPerDay  = secondsPerHour * hoursPerDay;
  const totalDays      = Math.floor(totalSeconds / secondsPerDay);
  return {
    totalSeconds,
    totalDays,
    dayOfWeek: totalDays % daysPerWeek,
    hour:   Math.floor((totalSeconds % secondsPerDay) / secondsPerHour),
    minute: Math.floor((totalSeconds % secondsPerHour) / 60),
    second: Math.floor(totalSeconds % 60)
  };
}

export function getCurrentWorldTime() {
  return secondsToComponents(game.time.worldTime);
}

export function registerWorldTimeHooks() {
  // Restore inn lodging availability for bookings that have expired. Only the active GM mutates
  // scene flags; the change propagates to every client (and re-renders open windows) via updateScene.
  Hooks.on("updateWorldTime", () => reclaimExpiredLodgingBookings());
  // Catch bookings that expired while the world was closed.
  Hooks.once("ready", () => reclaimExpiredLodgingBookings());
}

async function reclaimExpiredLodgingBookings() {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  const now = game.time.worldTime;

  for (const scene of game.scenes) {
    const locations = scene.getFlag(MODULE_ID, FLAGS.LOCATIONS);
    if (!locations?.length) continue;

    const cloned = foundry.utils.deepClone(locations);
    let changed = false;
    for (const location of cloned) {
      for (const entry of getTypeEntries(location).filter(e => e.typeId === LOCATION_TYPE_IDS.INN)) {
        const inn = location.typeData?.[entry.id];
        if (inn && reclaimExpiredBookings(location, inn, now)) changed = true;
      }
      for (const entry of getTypeEntries(location).filter(e => e.typeId === LOCATION_TYPE_IDS.BANK)) {
        const bank = location.typeData?.[entry.id];
        if (bank?.rentals?.length && reclaimExpiredStorageRentals(location, bank, now)) changed = true;
      }
    }
    if (changed) await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, cloned);
  }
}
