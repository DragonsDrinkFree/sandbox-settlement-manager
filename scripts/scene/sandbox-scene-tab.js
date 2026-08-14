/**
 * Shared "Sandbox" tab on the Scene Config sheet.
 *
 * This file is a portable contract, not module-specific logic: every module in the Sandbox family
 * ships an identical copy and calls getSandboxSceneSection() from its own renderSceneConfig hook.
 * Whichever module renders first creates the tab; the rest find it and add their own section.
 * See reference/foundry-reference/Shared-SceneConfig-Tab.md before changing anything here.
 *
 * The identifiers below are deliberately NOT namespaced to any module id — cooperating modules have
 * to agree on them, so namespacing them would defeat the entire purpose.
 */

const TAB_GROUP = "sheet";     // the tab group Scene Config uses
const TAB_ID    = "sandbox";
const TAB_ICON  = "fa-solid fa-cubes";

/** Fallback so a module that hasn't copied the lang key still gets a sensible tab label. */
const TAB_LABEL_KEY      = "SANDBOX.sceneTab";
const TAB_LABEL_FALLBACK = "Sandbox";

/**
 * Find-or-create the shared Sandbox tab, then find-or-create the calling module's section in it.
 *
 * @param {ApplicationV2} app       the SceneConfig instance from the render hook
 * @param {HTMLElement}   element   the sheet's root element from the render hook
 * @param {object}  options
 * @param {string}  options.moduleId  the calling module's id — keys its section
 * @param {string}  options.legend    fieldset legend, normally the module's title
 * @returns {HTMLFieldSetElement|null} the caller's own section when freshly created and still
 *   empty, or null when it already exists — so callers can populate unconditionally without
 *   duplicating their fields on every re-render.
 */
export function getSandboxSceneSection(app, element, { moduleId, legend }) {
  if (!element) return null;

  // The nav is core's "tabs" PART, so the whole <nav> is replaced on every re-render and our link
  // goes with it — it has to be rebuilt each time. The content panel below matches no part id and
  // therefore survives, so the two need independent existence checks, not one shared flag.
  const nav = element.querySelector("nav.tabs");
  let navLink = nav?.querySelector(`[data-tab="${TAB_ID}"][data-group="${TAB_GROUP}"]`);
  if (nav && !navLink) {
    navLink = document.createElement("a");
    navLink.dataset.action = "tab";   // core's own handler picks this up; no listener of our own
    navLink.dataset.group  = TAB_GROUP;
    navLink.dataset.tab    = TAB_ID;
    const label = game.i18n.has(TAB_LABEL_KEY) ? game.i18n.localize(TAB_LABEL_KEY) : TAB_LABEL_FALLBACK;
    navLink.innerHTML = `<i class="${TAB_ICON}" inert></i><span></span>`;
    navLink.querySelector("span").textContent = label;
    nav.append(navLink);
  }

  let panel = element.querySelector(`.tab[data-group="${TAB_GROUP}"][data-tab="${TAB_ID}"]`);
  if (!panel) {
    // Insert before the footer so the Save button stays last. Resolve the insertion point *first*:
    // building the panel with nowhere to put it would orphan it and leak a fresh one every render.
    const footer  = element.querySelector('[data-application-part="footer"]');
    const content = element.querySelector(".window-content");
    if (!footer && !content) return null;
    panel = document.createElement("div");
    panel.className = "tab standard-form";
    panel.dataset.group = TAB_GROUP;
    panel.dataset.tab   = TAB_ID;
    if (footer) footer.before(panel);
    else content.append(panel);
  }

  // Core's _prepareTabs only walks `static TABS`, which has no "sandbox" entry — so after a
  // re-render it marks *no* tab active when the user was on ours, leaving an empty sheet body.
  const isActive = app?.tabGroups?.[TAB_GROUP] === TAB_ID;
  navLink?.classList.toggle("active", isActive);
  panel.classList.toggle("active", isActive);

  const existing = panel.querySelector(`fieldset[data-sandbox-module="${moduleId}"]`);
  if (existing) return null;

  const section = document.createElement("fieldset");
  section.dataset.sandboxModule = moduleId;
  section.innerHTML = "<legend></legend>";
  section.querySelector("legend").textContent = legend ?? moduleId;
  panel.append(section);
  return section;
}
