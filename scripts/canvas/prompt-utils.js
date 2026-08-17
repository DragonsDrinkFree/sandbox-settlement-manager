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

/**
 * Prompt to rent Storage: which rental option (Storage Type), which of its offered periods, and
 * how many periods to prepay. Two dropdowns rather than one flattened list — a Bank with several
 * Storage Types otherwise fans out into a long "Name — fee / Day", "Name — fee / Week", ... list.
 * The Period dropdown cascades off the Storage Type selection via DialogV2.prompt's `render` hook,
 * which forwards through to DialogV2.wait's render callback (dialog.element reaches the live DOM) —
 * no need for a full ApplicationV2 dialog class just to get live re-population.
 *
 * rentalOptions: [{ id, name, periods: [{ unit, label }] }] — one entry per rental option, each
 * already filtered to the periods it actually offers (at/above its configured minimum).
 * Resolves { storageOptionId, periodUnit, periods } or null if cancelled.
 */
export async function promptStorageRental(rentalOptions) {
  if (!rentalOptions.length) return null;
  const typeOptions = rentalOptions.map(o => `<option value="${o.id}">${o.name}</option>`).join("");
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.rentPromptTitle") },
    content: `<div class="form-group"><label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.rentPromptStorageType")}</label>
      <select name="storageOptionId">${typeOptions}</select></div>
      <div class="form-group"><label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.rentPromptPeriodUnit")}</label>
      <select name="periodUnit"></select></div>
      <div class="form-group"><label>${game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.bank.storageRentals.rentPromptPeriods")}</label>
      <input type="number" name="periods" value="1" min="1" step="1"></div>`,
    render: (event, dialog) => {
      const typeSelect   = dialog.element.querySelector('[name="storageOptionId"]');
      const periodSelect = dialog.element.querySelector('[name="periodUnit"]');
      const populatePeriods = () => {
        const opt = rentalOptions.find(o => o.id === typeSelect.value);
        periodSelect.innerHTML = (opt?.periods ?? []).map(p => `<option value="${p.unit}">${p.label}</option>`).join("");
      };
      typeSelect.addEventListener("change", populatePeriods);
      populatePeriods();
    },
    ok: {
      label: game.i18n.localize("SANDBOX_SETTLEMENT_MANAGER.dialog.confirm"),
      callback: (event, btn) => {
        const storageOptionId = btn.form.querySelector('[name="storageOptionId"]')?.value;
        const periodUnit      = btn.form.querySelector('[name="periodUnit"]')?.value;
        const periods = Math.max(1, parseInt(btn.form.querySelector('[name="periods"]')?.value) || 1);
        return (storageOptionId && periodUnit) ? { storageOptionId, periodUnit, periods } : null;
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
