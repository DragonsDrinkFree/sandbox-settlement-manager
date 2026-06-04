import { MODULE_ID, FLAGS } from "./constants.js";

export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const SOCKET_TYPES = {
  SAVE_RESOURCE: "saveResource"
};

export function registerSocketHandlers() {
  game.socket.on(SOCKET_CHANNEL, async (data) => {
    if (!data?.type) return;

    // Player → GM messages: only the active GM processes each message once.
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;

    if (data.type === SOCKET_TYPES.SAVE_RESOURCE) {
      await _handleSaveResource(data);
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
