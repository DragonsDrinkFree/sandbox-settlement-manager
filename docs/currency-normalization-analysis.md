# Currency & Template Feature Normalization — Analysis

**Status:** Analysis only. Nothing here is implemented. Reviewed before any refactor.
**Scope:** Inn, Merchant, Bank — their currency handling and template→instance mechanics.

---

## 1. What's already well-normalized (keep, extend — don't duplicate)

`scripts/utils/currency-utils.js` is the single source of truth for currency *math* and is
used consistently:

| Function | Used by |
|---|---|
| `parseExchangeRate`, `costInStandard`, `totalOfferedInStandard` | purchase-dialog, cart-app |
| `calculateChange` | purchase-dialog (×3), cart-app (×4) |
| `formatAmounts` | purchase-dialog, cart-app, deposit display |
| `getSettlementMaxDenomValue` | purchase-dialog, cart-app |
| `grantCoinsToActor`, `removeCoinsFromActor` | socket.js deposit handlers (added for Bank) |

The "priced thing" shape `{ name, currencyId, amount }` (called `expense` in code) is already a
de-facto universal: inn lodging rentals, cart totals, and immediate purchases all build one and
feed it to `PurchaseDialog`. **This shape should be formally adopted as the canonical price object.**

---

## 2. Overlap / duplication found

### 2a. Coin grant/remove logic is triplicated  ⬅ highest-value, lowest-risk fix
The same "write coins to an actor" logic (attribute path vs. item-quantity vs. create-item) exists in **three** places:

- `currency-utils.js` → `grantCoinsToActor` / `removeCoinsFromActor` (canonical, takes a pre-computed coin map)
- `purchase-dialog.js` → `#grantCurrency` (lines ~233-275) / `#removeCurrency` (~463-475) — inline duplicate, but additionally computes the denomination breakdown via `calculateChange` before writing
- `cart-app.js` → inline attribute/item update blocks (lines ~257-294)

They have drifted slightly (e.g. item-create fallback via `game.items` vs `fromUuid`). A single bug fix
today must be made in three spots.

**Proposal:** make `grantCoinsToActor`/`removeCoinsFromActor` the only writers. Add one thin helper
`grantStandardToActor(actor, amountInStandard, currencies, mode, maxDenomValue)` that does
`calculateChange` then delegates to `grantCoinsToActor`. Rewrite `PurchaseDialog.#grantCurrency`/
`#removeCurrency` and the `cart-app` blocks to call these. Pure internal refactor, no data/UX change.

### 2b. Template→instance override tracking uses three different mechanisms
| Type | Override marker | Restore path | Sync on template edit |
|---|---|---|---|
| Inn | per-item `overridden: boolean` | `template-restore-dialog.js` + course-edit "Restore to Template" | **add-only** (`syncNewTemplateItems`) |
| Merchant | per-field `_templateValues` snapshot | `merchant-restore-dialog.js` | **full** add/remove/change (`syncMerchantInventory`) |
| Bank | whole-section `_settingsOverridden: boolean` | inline reset button | none |

Three concepts (`overridden`, `_templateValues`, `_settingsOverridden`) express the same idea:
"has this instance diverged from its template, and can it be reset?" The Merchant `_templateValues`
snapshot is the most capable (field-level divergence detection + restore) and is the natural model.

**Proposal (larger, stage later):** generalize the Merchant `_templateValues` pattern into a small
util `template-link.js` with:
- `linkToTemplate(record, templateRecord, fields)` — stamps `templateItemId` + `_templateValues`
- `isOverridden(record, fields)` / `diffFromTemplate(record, fields)` — divergence detection
- `restoreFields(record, fields)` — reset selected fields
- `syncCollection(instances, templates, fields, { mode: "add"|"full" })` — unify `syncNewTemplateItems`/`syncMerchantInventory`
Then migrate Inn (per-item) and Bank (treat its settings as a one-row collection) onto it. This removes
two of the three bespoke restore dialogs and the divergent sync code paths. **Higher risk — touches
persisted `overridden`/`_settingsOverridden` shapes, so it needs its own migration + plan.**

### 2c. Price + currency entry widget is hand-rolled ~6 times
`<input type="number" data-field="...Amount"> + <select data-field="...CurrencyId">` is duplicated in:
`sub-type-edit.hbs` (lodging day/week price, merchant item price), `menu-item-edit.hbs`,
`course-edit.hbs` (course price), and the per-instance editors. Markup, currency-option loop, and
the read-back JS are copy-pasted.

**Proposal:** a Handlebars partial `templates/partials/price-input.hbs` taking `{ fieldPrefix, price, currencies }`,
plus a `readPriceFromForm(el, prefix)` helper. Cosmetic/DRY; low risk but touches many templates.

---

## 3. Recommended sequencing (low-risk first)

1. **Unify coin grant/remove (2a).** Internal-only, no migration. Immediate correctness win.
2. **Adopt the canonical `{name, currencyId, amount}` price object** explicitly + document it. No code change beyond a typedef/comment and using it consistently.
3. **Price-input partial (2c).** DRY, low risk, improves the help-badge'd config UIs too.
4. **Generalize template-link (2b).** Largest; own plan + migration for `overridden`/`_settingsOverridden`. Do last.

Items 1–3 are safe to bundle. Item 4 should be its own approved plan.

---

## 4. Out of scope / explicitly fine as-is
- Currency math centralization (already done).
- Two purchase entry points (PurchaseDialog vs CartApp) — different UX intentionally; both already share the math layer.
- Socket routing for GM-authoritative writes (deposits/withdrawals) — recently added, consistent.
