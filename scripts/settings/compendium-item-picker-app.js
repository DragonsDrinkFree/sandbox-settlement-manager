import { MODULE_ID } from "../constants.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class CompendiumItemPickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  #resolve = null;
  #packId  = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-compendium-item-picker`,
    window: { title: "SANDBOX_SETTLEMENT_MANAGER.merchant.importFromCompendiumTitle", resizable: true },
    position: { width: 480, height: 520 },
    actions: { confirmImport: CompendiumItemPickerApp.#onConfirm }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/settings/compendium-item-picker.hbs` }
  };

  static open() {
    return new Promise(resolve => {
      const app = new CompendiumItemPickerApp();
      app.#resolve = resolve;
      app.render(true);
    });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const packs = game.packs.filter(p => p.documentName === "Item");
    if (!this.#packId && packs.length) this.#packId = packs[0].id;

    let items = [];
    if (this.#packId) {
      const pack = game.packs.get(this.#packId);
      if (pack) {
        await pack.getIndex({ fields: ["name", "img", "type"] });
        items = [...pack.index]
          .map(e => ({ uuid: e.uuid, name: e.name, img: e.img, type: e.type }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    context.packs = packs.map(p => ({ id: p.id, title: p.title ?? p.id }));
    context.items = items;
    return context;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this.element.querySelector('.ssm-cp-pack-select')?.addEventListener('change', e => {
      this.#packId = e.target.value;
      this.render({ parts: ["content"] });
    });

    this.element.querySelector('.ssm-cp-filter-input')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      this.element.querySelectorAll('.ssm-cp-item-row').forEach(row => {
        const name = row.querySelector('.ssm-cp-item-name')?.textContent?.toLowerCase() ?? '';
        row.style.display = (!q || name.includes(q)) ? '' : 'none';
      });
    });

    this.element.querySelector('.ssm-cp-select-all')?.addEventListener('click', () => {
      this.element.querySelectorAll('.ssm-cp-item-cb').forEach(cb => { cb.checked = true; });
    });

    this.element.querySelector('.ssm-cp-deselect-all')?.addEventListener('click', () => {
      this.element.querySelectorAll('.ssm-cp-item-cb').forEach(cb => { cb.checked = false; });
    });
  }

  static #onConfirm() {
    const checked = [...this.element.querySelectorAll('.ssm-cp-item-cb:checked')];
    const selected = checked.map(cb => ({ uuid: cb.value, name: cb.dataset.name }));
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(selected);
    this.close();
  }

  async close(options = {}) {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(null);
    return super.close(options);
  }

}
