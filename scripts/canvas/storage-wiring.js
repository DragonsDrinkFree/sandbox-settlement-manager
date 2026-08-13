// DOM wiring shared by LocationDetailApp and SettlementManageApp. These were byte-identical in
// both apps; they only touch the DOM, so they live here as free functions. Each app keeps ownership
// of its own AbortController and passes the signal in, exactly as before.

export function wireExchangePreview(section) {
  const feeRate      = parseFloat(section.dataset.feeRate) || 0;
  const fromAmtInput = section.querySelector('[data-field="fromAmount"]');
  const fromSel      = section.querySelector('[data-field="fromCurrency"]');
  const toSel        = section.querySelector('[data-field="toCurrency"]');
  const toPreview    = section.querySelector('[data-field="toAmountPreview"]');
  const feeEl        = section.querySelector('.ssm-exchange-fee-preview');
  const addBtn       = section.querySelector('[data-action="addExchangeToCart"]');

  const update = () => {
    const fromAmount = parseInt(fromAmtInput?.value) || 0;
    const fromOpt    = fromSel?.selectedOptions[0];
    const toOpt      = toSel?.selectedOptions[0];
    const balance    = parseFloat(fromOpt?.dataset.balance ?? '0');
    const sameCurr   = fromOpt?.value && fromOpt.value === toOpt?.value;
    const invalid    = !fromAmount || !fromOpt || !toOpt || sameCurr || fromAmount > balance;
    if (addBtn) addBtn.disabled = invalid;
    if (!fromAmount || !fromOpt || !toOpt || sameCurr) {
      if (toPreview) toPreview.value = '';
      if (feeEl) feeEl.textContent = '';
      return;
    }
    const fromRate = parseExchangeRate(fromOpt.dataset.rate);
    const toRate   = parseExchangeRate(toOpt.dataset.rate);
    const fromStd  = fromAmount * fromRate;
    if (toPreview) toPreview.value = toRate > 0 ? Math.floor(fromStd / toRate) : 0;
    if (feeEl) {
      if (feeRate > 0) {
        const feeStd     = fromStd * feeRate / 100;
        const currencies = (game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CONFIG)).currencies ?? [];
        const maxDenom   = currencies.reduce((m, c) => Math.max(m, parseExchangeRate(c.exchangeRate)), 0);
        const feeChange  = calculateChange(feeStd, currencies, maxDenom);
        feeEl.textContent = feeChange ? `Fee: ${formatAmounts(feeChange, currencies)}` : '';
      } else {
        feeEl.textContent = '';
      }
    }
  };

  // Set initial state (button disabled until user enters a valid amount)
  if (addBtn) addBtn.disabled = true;
  fromAmtInput?.addEventListener('input', update);
  fromSel?.addEventListener('change', update);
  toSel?.addEventListener('change', update);
}

export function wireStorageDropZones(element, onDrop) {
  element.querySelectorAll('.storage-group-drop-zone').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('dragenter', () => zone.classList.add('drag-over'));
    zone.addEventListener('drop', e => onDrop(e, zone));
  });
}

export function wireStorageItemSort(element) {
  element.querySelectorAll('.storage-item-table').forEach(table => {
    const headers = [...table.querySelectorAll('th[data-sort-key]')];
    headers.forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        const dir = th.classList.contains('sorted-asc') ? 'desc' : 'asc';
        headers.forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(`sorted-${dir}`);

        const numeric = key === 'quantity' || key === 'weight' || key === 'groupAccessible';
        const tbody = table.querySelector('tbody');
        const rows = [...tbody.querySelectorAll('tr.storage-item-row')].sort((a, b) => {
          const av = a.dataset[key] ?? '';
          const bv = b.dataset[key] ?? '';
          const cmp = numeric ? (parseFloat(av) || 0) - (parseFloat(bv) || 0) : av.localeCompare(bv);
          return dir === 'asc' ? cmp : -cmp;
        });
        rows.forEach(r => tbody.appendChild(r));
      });
    });
  });
}

export function wireStorageItemFilter(element) {
  element.querySelectorAll('.storage-item-filter').forEach(input => {
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      const wrap = input.closest('.storage-item-table-wrap');
      wrap?.querySelectorAll('.storage-item-depositor-group').forEach(depositorGroup => {
        let anyVisible = false;
        depositorGroup.querySelectorAll('tbody tr.storage-item-row').forEach(row => {
          const match = !q || (row.dataset.name ?? '').toLowerCase().includes(q);
          row.hidden = !match;
          if (match) anyVisible = true;
        });
        depositorGroup.hidden = !anyVisible;
      });
    });
  });
}

export function wireStorageAccessibleCheckboxes(element, onToggle) {
  element.querySelectorAll('.storage-group-accessible-checkbox').forEach(cb => {
    cb.addEventListener('change', () => onToggle(cb.dataset.itemId, cb.checked));
  });
}

export function wireStorageAccessBadges(element, signal) {
  element.querySelectorAll('.storage-access-badge-widget').forEach(widget => {
    const trigger = widget.querySelector('.storage-access-badge');
    const dropdown = widget.querySelector('.ssm-storage-access-badge-dropdown');
    if (!trigger || !dropdown) return;

    document.body.appendChild(dropdown);
    dropdownEls.push(dropdown);

    const position = () => {
      const r = trigger.getBoundingClientRect();
      dropdown.style.top  = `${r.bottom + 2}px`;
      dropdown.style.left = `${r.left}px`;
    };
    const open  = () => { position(); dropdown.classList.add('is-open'); };
    const close = () => dropdown.classList.remove('is-open');

    trigger.addEventListener('click', e => { e.stopPropagation(); dropdown.classList.contains('is-open') ? close() : open(); }, { signal });
    document.addEventListener('click', close, { signal });
    dropdown.addEventListener('click', e => e.stopPropagation(), { signal });
  });
}

export function wireActorDropdown(widget, signal, onSelect, dropdownEls) {
  const trigger = widget.querySelector('.ssm-actor-dropdown-trigger');
  const list    = widget.querySelector('.ssm-actor-dropdown-list');
  if (!trigger || !list) return;

  document.body.appendChild(list);
  dropdownEls.push(list);

  const position = () => {
    const r = trigger.getBoundingClientRect();
    list.style.top      = `${r.bottom + 2}px`;
    list.style.left     = `${r.left}px`;
    list.style.minWidth = `${r.width}px`;
  };
  const open  = () => { position(); list.classList.add('is-open'); list.querySelector('.ssm-actor-dropdown-search')?.focus(); };
  const close = () => list.classList.remove('is-open');

  trigger.addEventListener('click', e => { e.stopPropagation(); list.classList.contains('is-open') ? close() : open(); }, { signal });
  document.addEventListener('click', close, { signal });
  list.addEventListener('click', e => e.stopPropagation(), { signal });

  list.querySelector('.ssm-actor-dropdown-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    list.querySelectorAll('.ssm-actor-option').forEach(opt => {
      if (opt.classList.contains('ssm-actor-option-empty')) { opt.style.display = ''; return; }
      opt.style.display = (!q || opt.textContent.trim().toLowerCase().includes(q)) ? '' : 'none';
    });
  }, { signal });

  list.querySelectorAll('.ssm-actor-option').forEach(opt => {
    opt.addEventListener('click', () => { onSelect(opt.dataset.actorId || null); close(); }, { signal });
  });
}

export function wireActorFilterMenu(btn, actorFilter, signal, onApply) {
  const applyFromMenu = (menu) => {
    const playerOwned  = menu.querySelector('.ssm-af-player-owned')?.checked ?? true;
    const typeCbs      = [...menu.querySelectorAll('.ssm-af-type')];
    const allChecked   = typeCbs.every(cb => cb.checked);
    const checkedTypes = typeCbs.filter(cb => cb.checked).map(cb => cb.dataset.type);
    onApply({ playerOwned, types: allChecked ? null : (checkedTypes.length ? new Set(checkedTypes) : null) });
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const existing = document.querySelector('.ssm-actor-filter-menu');
    if (existing) {
      // Toggle-close: clicking the filter button again while the menu is open commits and closes it,
      // rather than tearing it down and immediately reopening a fresh copy.
      existing.remove();
      applyFromMenu(existing);
      return;
    }

    const types = Object.entries(CONFIG.Actor.typeLabels ?? {}).map(([id, label]) => ({
      id,
      label: typeof label === 'string' ? game.i18n.localize(label) : id,
      checked: !actorFilter.types || actorFilter.types.has(id)
    }));

    const menu = document.createElement('div');
    menu.className = 'ssm-actor-filter-menu';
    menu.innerHTML = `
      <label class="ssm-af-row"><input type="checkbox" class="ssm-af-player-owned"${actorFilter.playerOwned ? ' checked' : ''}> ${game.i18n.localize('SANDBOX_SETTLEMENT_MANAGER.actor.playerOwned')}</label>
      <hr class="ssm-af-divider">
      ${types.map(t => `<label class="ssm-af-row"><input type="checkbox" class="ssm-af-type" data-type="${t.id}"${t.checked ? ' checked' : ''}> ${t.label}</label>`).join('')}
    `;

    const rect = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top  = `${rect.bottom + 2}px`;
    menu.style.left = `${rect.left}px`;
    document.body.appendChild(menu);

    menu.addEventListener('click', e => e.stopPropagation());
    // Checkbox changes accumulate locally while the menu is open — no apply/render happens until
    // the menu closes (below), so the user can freely toggle multiple boxes without it disappearing.
    document.addEventListener('click', () => {
      if (!menu.isConnected) return; // already closed via the toggle-button path above
      menu.remove();
      applyFromMenu(menu);
    }, { once: true, signal });
  }, { signal });
}
