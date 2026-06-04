import { MODULE_ID, SETTINGS } from "../constants.js";

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
  Hooks.on("updateWorldTime", (worldTime, dt) => {
    const c = secondsToComponents(worldTime);
    console.debug(
      `${MODULE_ID} | time ${dt >= 0 ? "+" : ""}${dt}s → day ${c.totalDays} (weekday ${c.dayOfWeek}), ` +
      `${c.hour}:${String(c.minute).padStart(2, "0")}`
    );
    // Future: check inn expiry, inventory refresh triggers
  });
}
