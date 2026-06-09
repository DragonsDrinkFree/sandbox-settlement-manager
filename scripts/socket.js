import { MODULE_ID, FLAGS, SETTINGS } from "./constants.js";
import { grantCoinsToActor, calculateChange, parseExchangeRate, totalOfferedInStandard } from "./utils/currency-utils.js";

export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const SOCKET_TYPES = {
  SAVE_LOCATION:      "saveLocation",
  RECORD_DEPOSIT:     "recordDeposit",
  PROCESS_WITHDRAWAL: "processWithdrawal"
};

export function registerSocketHandlers() {
  game.socket.on(SOCKET_CHANNEL, async (data) => {
    if (!data?.type) return;

    // Player → GM messages: only the active GM processes each message once.
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;

    if (data.type === SOCKET_TYPES.SAVE_LOCATION) {
      await _handleSaveLocation(data);
    } else if (data.type === SOCKET_TYPES.RECORD_DEPOSIT) {
      await _handleRecordDeposit(data);
    } else if (data.type === SOCKET_TYPES.PROCESS_WITHDRAWAL) {
      await _handleProcessWithdrawal(data);
    }
  });
}

/**
 * GM-side handler: replaces a single location in the scene flag by ID.
 * Players cannot write scene flags directly, so all location mutations from
 * non-GM clients are routed here via socket.
 */
async function _handleSaveLocation({ sceneId, location }) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const locations = scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? [];
  const index = locations.findIndex(r => r.id === location.id);
  if (index === -1) return;
  locations[index] = location;
  await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
}

/** GM-side: record a new deposit into either world setting (global) or scene flag. */
export async function _handleRecordDeposit({ deposit, locationId, entryId, sceneId, isGlobal }) {
  if (isGlobal) {
    const existing = game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [];
    await game.settings.set(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS, [...existing, deposit]);
  } else {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
    const location  = locations.find(r => r.id === locationId);
    if (!location?.typeData?.[entryId]) return;
    location.typeData[entryId].deposits = [...(location.typeData[entryId].deposits ?? []), deposit];
    await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  }
  _refreshBankApps();
}

/**
 * GM-side: process a withdrawal.
 * Deducts withdrawCoins from the deposit records, consolidates matured deposits,
 * then grants the payout (minus early fee) to the actor.
 */
export async function _handleProcessWithdrawal({
  depositIds, withdrawCoins, actorId, earlyFeeRate,
  locationId, entryId, sceneId, isGlobal
}) {
  const currencyConfig = game.settings.get(MODULE_ID, "currencyConfig");
  const currencies     = currencyConfig.currencies ?? [];
  const mode           = currencyConfig.mode ?? 'loose';
  const actor          = game.actors.get(actorId);
  if (!actor) return;

  // Load current deposits
  let allDeposits;
  let scene, locations, location;
  if (isGlobal) {
    allDeposits = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? []);
  } else {
    scene     = game.scenes.get(sceneId);
    if (!scene) return;
    locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
    location  = locations.find(r => r.id === locationId);
    allDeposits = foundry.utils.deepClone(location?.typeData?.[entryId]?.deposits ?? []);
  }

  // Deduct withdrawCoins from target deposit records
  const targetIds = new Set(depositIds);
  for (const dep of allDeposits) {
    if (!targetIds.has(dep.id)) continue;
    for (const [cId, amt] of Object.entries(withdrawCoins)) {
      dep.coins[cId] = Math.max(0, (dep.coins[cId] ?? 0) - amt);
      if (dep.coins[cId] <= 0) delete dep.coins[cId];
    }
  }
  // Remove fully emptied deposits
  const trimmed = allDeposits.filter(d => Object.keys(d.coins).length > 0);

  // Consolidate matured deposits for this actor
  const consolidated = _consolidateMatureDeposits(trimmed, actorId);

  // Save back
  if (isGlobal) {
    await game.settings.set(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS, consolidated);
  } else if (location?.typeData?.[entryId]) {
    location.typeData[entryId].deposits = consolidated;
    await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  }

  // Compute payout: withdrawCoins minus proportional early fee
  let payoutCoins;
  if (earlyFeeRate > 0) {
    const totalStd  = totalOfferedInStandard(withdrawCoins, currencies);
    const feeStd    = totalStd * earlyFeeRate / 100;
    const payoutStd = Math.max(0, totalStd - feeStd);
    const maxDenom  = currencies.reduce((m, c) => Math.max(m, parseExchangeRate(c.exchangeRate)), 0);
    payoutCoins = calculateChange(payoutStd, currencies, maxDenom) ?? {};
  } else {
    payoutCoins = { ...withdrawCoins };
  }

  // Grant payout to actor
  if (mode !== 'loose') {
    await grantCoinsToActor(actor, payoutCoins, currencies, mode);
  }

  _refreshBankApps();
}

/** Consolidate multiple matured deposits for each actor into one record. */
export function _consolidateMatureDeposits(deposits, filterActorId = null) {
  const now    = game.time.worldTime;
  const byActor = new Map();

  for (const dep of deposits) {
    if (!byActor.has(dep.actorId)) byActor.set(dep.actorId, { matured: [], unmatured: [] });
    const bucket = byActor.get(dep.actorId);
    if (now >= dep.depositedAt + dep.minDepositSeconds) bucket.matured.push(dep);
    else bucket.unmatured.push(dep);
  }

  const result = [];
  for (const [actorId, { matured, unmatured }] of byActor) {
    if (filterActorId && actorId !== filterActorId) {
      result.push(...matured, ...unmatured);
      continue;
    }
    if (matured.length > 1) {
      const merged = { ...matured[0], coins: {}, minDepositSeconds: 0 };
      for (const d of matured) {
        for (const [cId, amt] of Object.entries(d.coins)) {
          merged.coins[cId] = (merged.coins[cId] ?? 0) + amt;
        }
      }
      result.push(merged, ...unmatured);
    } else {
      result.push(...matured, ...unmatured);
    }
  }
  return result;
}

/** Re-render any open bank location windows so balances stay current. */
function _refreshBankApps() {
  for (const app of foundry.applications.instances.values()) {
    if (app.id === 'sandbox-settlement-manager-location-detail') app.render();
    else if (app.id === 'sandbox-settlement-manager-settlement-manage') app.render({ parts: ['content'] });
  }
}
