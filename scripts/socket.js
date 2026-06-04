import { MODULE_ID, FLAGS } from "./constants.js";

export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const SOCKET_TYPES = {
  ADD_LEDGER_ENTRY: "addLedgerEntry"
};

export function registerSocketHandlers() {
  game.socket.on(SOCKET_CHANNEL, async (data) => {
    if (!data?.type) return;

    // Player → GM messages: only the active GM processes each message once.
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;

    if (data.type === SOCKET_TYPES.ADD_LEDGER_ENTRY) {
      await _handleAddLedgerEntry(data);
    }
  });
}

async function _handleAddLedgerEntry({ sceneId, resourceId, entry }) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const resources = scene.getFlag(MODULE_ID, FLAGS.RESOURCES) ?? [];
  const resource = resources.find(r => r.id === resourceId);
  if (!resource) return;
  resource.typeData ??= {};
  resource.typeData.inn ??= { lodgings: [], ledger: [] };
  resource.typeData.inn.ledger ??= [];
  resource.typeData.inn.ledger.push(entry);
  await scene.setFlag(MODULE_ID, FLAGS.RESOURCES, resources);
}
