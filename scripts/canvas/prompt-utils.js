// Shared DialogV2 prompt helpers used by both the player-facing LocationDetailApp and the GM
// SettlementManageApp. These were previously duplicated verbatim in each app; they hold no app
// state, so they live here as plain module-scope functions.

/** Prompt for how many of a stack to move (deposit or take). Returns a clamped integer, or null if cancelled. */
export async function promptQuantity(max, { title } = {}) {
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: title ?? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.quantityPromptTitle") },
    content: `<div class="form-group"><label>${game.i18n.format("SANDBOX_SETTLEMENT_MANAGER.storage.quantityPromptLabel", { max })}</label>
      <input type="number" name="qty" value="${max}" min="1" max="${max}" step="1"></div>`,
    ok: {
      label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.quantityPromptConfirm"),
      callback: (event, btn) => {
        const v = parseInt(btn.form.querySelector('[name="qty"]')?.value);
        return Number.isFinite(v) ? Math.max(1, Math.min(max, v)) : null;
      }
    }
  });
  return result ?? null;
}

/** Prompt for a Storage Area's private GM note. Returns the trimmed string, or null if cancelled. */
export async function promptStorageGroupNote(currentNote) {
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.group.noteTitle") },
    content: `<div class="form-group" style="flex-direction: column; align-items: stretch;">
      <label style="margin-bottom: 0.3rem;">${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.group.noteLabel")}</label>
      <textarea name="note" rows="5" style="width: 100%;" placeholder="${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.group.notePlaceholder")}">${currentNote ?? ""}</textarea></div>`,
    ok: {
      label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.confirm"),
      callback: (event, btn) => btn.form.querySelector('[name="note"]')?.value ?? ""
    }
  });
  return result === null ? null : result.trim();
}

/** Prompt to pick one of several actors (e.g. which of the player's actors receives a taken item). */
export async function promptActorChoice(actors, { title, label, alwaysShow = false } = {}) {
  if (!actors.length) return null;
  if (!alwaysShow && actors.length === 1) return actors[0];
  const options = actors.map(a => `<option value="${a.id}">${a.name}</option>`).join("");
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: title ?? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.actorPromptTitle") },
    content: `<div class="form-group"><label>${label ?? game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.storage.actorPromptLabel")}</label><select name="actorId">${options}</select></div>`,
    ok: {
      label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.confirm"),
      callback: (event, btn) => btn.form.querySelector('[name="actorId"]')?.value
    }
  });
  if (!result) return null;
  return actors.find(a => a.id === result) ?? null;
}

/** Prompt to pick a Storage Rental Option and how many periods to prepay. Returns { storageOptionId, periods }, or null. */
export async function promptStorageRental(labeledOptions) {
  if (!labeledOptions.length) return null;
  const options = labeledOptions.map(o => `<option value="${o.id}">${o.label}</option>`).join("");
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.rentPromptTitle") },
    content: `<div class="form-group"><label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.rentPromptStorageType")}</label>
      <select name="storageOptionKey">${options}</select></div>
      <div class="form-group"><label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.rentPromptPeriods")}</label>
      <input type="number" name="periods" value="1" min="1" step="1"></div>`,
    ok: {
      label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.confirm"),
      callback: (event, btn) => {
        // Each row is one option at one rate, keyed "<optionId>::<periodUnit>".
        const storageOptionKey = btn.form.querySelector('[name="storageOptionKey"]')?.value;
        const periods = Math.max(1, parseInt(btn.form.querySelector('[name="periods"]')?.value) || 1);
        return storageOptionKey ? { storageOptionKey, periods } : null;
      }
    }
  });
  return result ?? null;
}

/** Prompt for the name of a newly-rented Storage Area, pre-filled with the auto-generated default. Returns the (possibly-edited) name, or null if cancelled. */
export async function promptStorageAreaName(defaultName) {
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.areaNamePromptTitle") },
    content: `<div class="form-group"><label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.areaNamePromptLabel")}</label>
      <input type="text" name="areaName" value="${defaultName}"></div>`,
    ok: {
      label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.confirm"),
      callback: (event, btn) => (btn.form.querySelector('[name="areaName"]')?.value ?? "").trim()
    }
  });
  if (result === null) return null;
  return result || defaultName;
}
