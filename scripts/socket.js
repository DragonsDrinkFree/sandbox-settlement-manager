import { MODULE_ID, FLAGS } from "./constants.js";
import { grantCoinsToActor, calculateChange, parseExchangeRate, totalOfferedInStandard } from "./utils/currency-utils.js";

export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const SOCKET_TYPES = {
  SAVE_RESOURCE:      "saveResource",
  RECORD_DEPOSIT:     "recordDeposit",
  PROCESS_WITHDRAWAL: "processWithdrawal"
};

export function registerSocketHandlers() {
  game.socket.on(SOCKET_CHANNEL, async (data) => {
    if (!data?.type) return;

    // Player → GM messages: only the active GM processes each message once.
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;

    if (data.type === SOCKET_TYPES.SAVE_RESOURCE) {
      await _handleSaveResource(data);
    } else if (data.type === SOCKET_TYPES.RECORD_DEPOSIT) {
      await _handleRecordDeposit(data);
    } else if (data.type === SOCKET_TYPES.PROCESS_WITHDRAWAL) {
      await _handleProcessWithdrawal(data);
    }
  });
}

/**
 * GM-side handler: replaces a single resource in the scene flag by ID.
 * Players cannot write scene flags directly, so all resource mutations from
 * non-GM clients are routed here via socket.
 */
async function _handleSaveResource({ sceneId, resource }) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const resources = scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
  const index = resources.findIndex(r => r.id === resource.id);
  if (index === -1) return;
  resources[index] = resource;
  await scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
}

/** GM-side: record a new deposit into either world flag (global) or scene flag. */
export async function _handleRecordDeposit({ deposit, resourceId, sceneId, isGlobal }) {
  if (isGlobal) {
    const existing = game.world.getFlag(MODULE_ID, FLAGS.GLOBAL_DEPOSITS) ?? [];
    await game.world.setFlag(MODULE_ID, FLAGS.GLOBAL_DEPOSITS, [...existing, deposit]);
  } else {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const resources = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? []);
    const resource  = resources.find(r => r.id === resourceId);
    if (!resource?.typeData?.bank) return;
    resource.typeData.bank.deposits = [...(resource.typeData.bank.deposits ?? []), deposit];
    await scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
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
  resourceId, sceneId, isGlobal
}) {
  const currencyConfig = game.settings.get(MODULE_ID, "currencyConfig");
  const currencies     = currencyConfig.currencies ?? [];
  const mode           = currencyConfig.mode ?? 'loose';
  const actor          = game.actors.get(actorId);
  if (!actor) return;

  // Load current deposits
  let allDeposits;
  let scene, resources, resource;
  if (isGlobal) {
    allDeposits = foundry.utils.deepClone(game.world.getFlag(MODULE_ID, FLAGS.GLOBAL_DEPOSITS) ?? []);
  } else {
    scene     = game.scenes.get(sceneId);
    if (!scene) return;
    resources = foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? []);
    resource  = resources.find(r => r.id === resourceId);
    allDeposits = foundry.utils.deepClone(resource?.typeData?.bank?.deposits ?? []);
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
    await game.world.setFlag(MODULE_ID, FLAGS.GLOBAL_DEPOSITS, consolidated);
  } else if (resource?.typeData?.bank) {
    resource.typeData.bank.deposits = consolidated;
    await scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
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

/** Re-render any open bank resource windows so balances stay current. */
function _refreshBankApps() {
  for (const app of foundry.applications.instances.values()) {
    if (app.id === 'sandbox-settlement-manager-resource-detail') app.render();
    else if (app.id === 'sandbox-settlement-manager-city-manage') app.render({ parts: ['content'] });
  }
}
