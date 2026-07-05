import { MODULE_ID, FLAGS, SETTINGS } from "./constants.js";
import { grantCoinsToActor, calculateChange, parseExchangeRate, totalOfferedInStandard, getMaxDenomValue } from "./utils/currency-utils.js";

export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const SOCKET_TYPES = {
  SAVE_LOCATION:          "saveLocation",
  RECORD_DEPOSIT:         "recordDeposit",
  PROCESS_WITHDRAWAL:     "processWithdrawal",
  RECORD_LEDGER_ENTRIES:  "recordLedgerEntries"
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
      // Bank actions wrap their fields under `payload`; unwrap before handling.
      await _handleRecordDeposit(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.PROCESS_WITHDRAWAL) {
      await _handleProcessWithdrawal(data.payload ?? data);
    } else if (data.type === SOCKET_TYPES.RECORD_LEDGER_ENTRIES) {
      await _handleRecordLedgerEntries(data);
    } else {
      console.warn(`${MODULE_ID} | Unknown socket message type: ${data.type}`);
    }
  });
}

/**
 * True when the given user owns the given actor. Used to reject bank socket
 * messages that target an actor the requesting player does not control.
 */
function _userOwnsActor(userId, actorId) {
  const user  = game.users.get(userId);
  const actor = game.actors.get(actorId);
  if (!user || !actor) return false;
  return actor.testUserPermission(user, "OWNER");
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
export async function _handleRecordDeposit({ deposit, locationId, entryId, sceneId, isGlobal, userId }) {
  if (!_userOwnsActor(userId, deposit?.actorId)) return;
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
  locationId, entryId, sceneId, isGlobal, userId
}) {
  if (!_userOwnsActor(userId, actorId)) return;
  const currencyConfig = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG) ?? { currencies: [] };
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

  // The client sends the bank's *configured* early-withdrawal rate regardless of whether this
  // particular deposit has actually matured; only trust it (and only re-denominate the payout
  // below) if at least one targeted deposit genuinely hasn't matured yet.
  const targetIds = new Set(depositIds);
  const now = game.time.worldTime;
  const isEarly = allDeposits.some(d => targetIds.has(d.id) && now < d.depositedAt + d.minDepositSeconds);
  const effectiveFeeRate = isEarly ? earlyFeeRate : 0;

  // Deduct withdrawCoins from the matched deposit records, treated as a shared pool: each
  // currency's withdrawn total comes out of the group as a whole (draining one record before
  // moving to the next), not from every matched record independently — otherwise a partial
  // withdrawal from a merged/matured group would wipe out every record's balance, destroying
  // whatever wasn't withdrawn.
  const matchedDeposits = allDeposits.filter(d => targetIds.has(d.id));
  for (const [cId, amt] of Object.entries(withdrawCoins)) {
    let remaining = amt;
    for (const dep of matchedDeposits) {
      if (remaining <= 0) break;
      const available = dep.coins[cId] ?? 0;
      const take = Math.min(available, remaining);
      if (take <= 0) continue;
      dep.coins[cId] = available - take;
      if (dep.coins[cId] <= 0) delete dep.coins[cId];
      remaining -= take;
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

  // Compute payout: withdrawCoins minus proportional early fee (only when genuinely early — see
  // effectiveFeeRate above). When no fee applies, the payout is exactly the coins withdrawn.
  let payoutCoins;
  if (effectiveFeeRate > 0) {
    const totalStd  = totalOfferedInStandard(withdrawCoins, currencies);
    const feeStd    = totalStd * effectiveFeeRate / 100;
    const payoutStd = Math.max(0, totalStd - feeStd);
    // Cap re-denomination to the highest-value coin actually withdrawn, so a fee can never turn
    // the payout into a larger/unrelated denomination (e.g. GP becoming PP) the player never handled.
    const withdrawnRates = Object.keys(withdrawCoins)
      .map(cId => parseExchangeRate(currencies.find(c => c.id === cId)?.exchangeRate));
    const maxDenom = withdrawnRates.length ? Math.max(...withdrawnRates) : getMaxDenomValue(currencies);
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

/**
 * GM-only: apply an edit to one or more deposit records (as displayed via a possibly-merged row).
 * Removes every deposit whose id is in `targetIds` and appends the single `updatedDeposit` in its
 * place, consolidating merged/matured records into one. Called directly from the GM-gated edit
 * dialog — never routed through the socket dispatcher, so no actor-ownership check is needed here
 * (unlike _handleRecordDeposit/_handleProcessWithdrawal, which do get called via player sockets).
 */
export async function _handleEditDeposit({ targetIds, updatedDeposit, locationId, entryId, sceneId, isGlobal }) {
  const targetSet = new Set(targetIds);
  if (isGlobal) {
    const existing = game.settings.get(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS) ?? [];
    const kept = existing.filter(d => !targetSet.has(d.id));
    await game.settings.set(MODULE_ID, SETTINGS.GLOBAL_DEPOSITS, [...kept, updatedDeposit]);
  } else {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const locations = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.LOCATIONS) ?? []);
    const location  = locations.find(r => r.id === locationId);
    if (!location?.typeData?.[entryId]) return;
    const existing = location.typeData[entryId].deposits ?? [];
    location.typeData[entryId].deposits = [...existing.filter(d => !targetSet.has(d.id)), updatedDeposit];
    await scene.setFlag(MODULE_ID, FLAGS.LOCATIONS, locations);
  }
  _refreshBankApps();
}

/** GM-side: append ledger entries to the scene flag. */
async function _handleRecordLedgerEntries({ sceneId, entries }) {
  const scene = game.scenes.get(sceneId);
  if (!scene || !entries?.length) return;
  const existing = scene.getFlag(MODULE_ID, FLAGS.LEDGER) ?? [];
  await scene.setFlag(MODULE_ID, FLAGS.LEDGER, [...existing, ...entries]);
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
