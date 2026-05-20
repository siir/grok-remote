// Settings view: default model, default cwd, auto-approve, theme.
// Saves via PATCH /api/settings.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';
import { THEMES, getTheme, setTheme } from '../lib/themes.js';

function clampInt(raw, min, max, fallback) {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export class SettingsView {
  constructor() {
    this.settings = {};
    this.models   = [];

    this.modelInput   = el('input', { class: 'inp', type: 'text', placeholder: 'grok-build' });
    this.modelSelect  = null;
    this.cwdInput     = el('input', { class: 'inp', type: 'text', placeholder: '/path/to/working/dir' });
    this.autoApprove  = el('input', { type: 'checkbox' });
    this.debugToggle  = el('input', { type: 'checkbox' });
    this.retentionInput = el('input', { class: 'inp inp--num', type: 'number', min: '0', max: '3650', step: '1', placeholder: '30' });
    this.themePicker = this.buildThemePicker();

    this.statusEl = el('div', { class: 'settings-status' });

    this.saveBtn = el('button', {
      class: 'btn btn--primary',
      onclick: (ev) => { ev.preventDefault(); this.save(); },
    }, 'save');

    this.reloadBtn = el('button', {
      class: 'btn btn--ghost',
      onclick: (ev) => { ev.preventDefault(); this.load(); },
    }, 'reload');

    this.modelFieldHost = el('div', { class: 'field-host' }, this.modelInput);

    this.root = el('section', { class: 'settings' },
      el('h2', { class: 'settings-title' }, 'settings'),
      this.statusEl,

      this.field('default model',
        this.modelFieldHost,
        'used when you spawn a new agent without specifying one.'),

      this.field('default cwd',
        this.cwdInput,
        'fallback working directory for new agents.'),

      this.field('auto-approve tools',
        el('label', { class: 'toggle' }, this.autoApprove,
          el('span', { class: 'toggle-text' }, 'on')),
        'server already passes --always-approve. shown here for visibility.'),

      this.field('debug controls',
        el('label', { class: 'toggle' }, this.debugToggle,
          el('span', { class: 'toggle-text' }, 'show developer affordances')),
        'shows the { payload } button in the composer to inspect the exact JSON sent to the agent.'),

      this.field('history retention (days)',
        this.retentionInput,
        'agent history under ~/.grok-remote/agents/ is pruned when last activity exceeds this. starred agents are never pruned. 0 disables cleanup. default 30.'),

      this.field('theme',
        this.themePicker,
        'applies instantly. saved in this browser only.'),

      el('div', { class: 'settings-actions' }, this.saveBtn, this.reloadBtn),
    );
  }

  field(label, control, help) {
    return el('div', { class: 'field' },
      el('label', { class: 'field-label' }, label),
      control,
      help ? el('div', { class: 'field-help' }, help) : null,
    );
  }

  mount(parent) {
    parent.appendChild(this.root);
    // Refresh the picker against any external theme changes (e.g. topbar toggle).
    this.refreshThemePicker();
    this.load();
  }

  refreshThemePicker() {
    const current = getTheme();
    for (const [k, card] of Object.entries(this.themeCards || {})) {
      card.classList.toggle('theme-card--selected', k === current);
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = (k === current);
    }
  }

  async load() {
    this.setStatus('loading...', 'idle');
    try {
      const [settings, modelsResp] = await Promise.allSettled([
        api.getSettings(),
        api.models(),
      ]);
      if (settings.status === 'fulfilled' && settings.value) {
        this.settings = settings.value || {};
        this.modelInput.value  = this.settings.defaultModel || '';
        this.cwdInput.value    = this.settings.defaultCwd   || '';
        this.autoApprove.checked = !!this.settings.autoApprove;
        this.debugToggle.checked = !!this.settings.debug;
        const rd = (this.settings.retentionDays != null) ? Number(this.settings.retentionDays) : 30;
        this.retentionInput.value = Number.isFinite(rd) ? String(Math.max(0, Math.min(3650, rd))) : '30';
      } else {
        this.setStatus('settings unreachable · using defaults', 'warn');
      }

      let models = [];
      if (modelsResp.status === 'fulfilled' && modelsResp.value) {
        const m = modelsResp.value;
        if (Array.isArray(m)) models = m;
        else if (Array.isArray(m.models)) models = m.models;
      }
      this.models = models;
      this.swapModelField();
      if (settings.status === 'fulfilled') this.setStatus('loaded', 'ok');
    } catch (e) {
      this.setStatus(`load failed: ${e.message}`, 'fail');
    }
  }

  swapModelField() {
    if (Array.isArray(this.models) && this.models.length) {
      const sel = el('select', { class: 'inp' });
      const cur = this.modelInput.value || this.settings.defaultModel || '';
      sel.appendChild(el('option', { value: '' }, '(unset)'));
      for (const m of this.models) {
        const id = typeof m === 'string' ? m : (m.id || m.name || m.modelId);
        if (!id) continue;
        const opt = el('option', { value: id }, id);
        if (id === cur) opt.selected = true;
        sel.appendChild(opt);
      }
      // Always allow a free-form custom value too.
      const customRow = el('div', { class: 'model-custom' },
        el('span', { class: 'model-custom-label' }, 'or custom:'),
        this.modelInput,
      );
      this.modelSelect = sel;
      this.modelFieldHost.replaceChildren(sel, customRow);
    } else {
      this.modelFieldHost.replaceChildren(this.modelInput);
    }
  }

  async save() {
    const body = {
      defaultModel: this.modelSelect && this.modelSelect.value
        ? this.modelSelect.value
        : (this.modelInput.value.trim() || null),
      defaultCwd:   this.cwdInput.value.trim() || null,
      autoApprove:  !!this.autoApprove.checked,
      debug:        !!this.debugToggle.checked,
      retentionDays: clampInt(this.retentionInput.value, 0, 3650, 30),
      // theme is persisted client-side in localStorage by setTheme(); we still
      // forward it so server-side settings can mirror the preference if useful.
      theme:        getTheme(),
    };
    this.saveBtn.disabled = true;
    this.setStatus('saving...', 'idle');
    try {
      const updated = await api.patchSettings(body);
      this.settings = updated || body;
      this.setStatus('saved', 'ok');
      // Notify the rest of the app (chat view, etc.) so debug-gated UI
      // updates without a page reload.
      window.dispatchEvent(new CustomEvent('grok-remote:settings-change', {
        detail: this.settings,
      }));
    } catch (e) {
      this.setStatus(`save failed: ${e.message}`, 'fail');
    } finally {
      this.saveBtn.disabled = false;
    }
  }

  setStatus(text, kind) {
    this.statusEl.replaceChildren(
      el('span', { class: `status-pill status-pill--${kind || 'idle'}` }, '·'),
      el('span', { class: 'settings-status-text' }, text),
    );
  }

  buildThemePicker() {
    const current = getTheme();
    const grid = el('div', { class: 'theme-grid' });
    this.themeCards = {};
    for (const t of THEMES) {
      const isSel = t.name === current;
      const card = el('label', {
        class: `theme-card${isSel ? ' theme-card--selected' : ''}`,
        dataset: { theme: t.name },
      },
        el('input', {
          type: 'radio',
          name: 'theme',
          value: t.name,
          checked: isSel ? 'checked' : null,
          onchange: () => this.pickTheme(t.name),
        }),
        el('span', { class: 'theme-card-swatch', style: { background: t.swatch, borderColor: t.accent, color: t.accent } }, '●'),
        el('span', { class: 'theme-card-body' },
          el('span', { class: 'theme-card-name' }, t.label),
          el('span', { class: 'theme-card-blurb' }, t.blurb),
        ),
      );
      this.themeCards[t.name] = card;
      grid.appendChild(card);
    }
    return grid;
  }

  pickTheme(name) {
    setTheme(name);
    for (const [k, card] of Object.entries(this.themeCards || {})) {
      card.classList.toggle('theme-card--selected', k === name);
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = (k === name);
    }
    // notify the topbar toggle so its dot/label re-syncs.
    window.dispatchEvent(new CustomEvent('grok-remote:theme-change', { detail: { theme: name } }));
  }
}
