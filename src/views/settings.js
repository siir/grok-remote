// Settings view: default model, default cwd, auto-approve, theme.
// Saves via PATCH /api/settings.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';

export class SettingsView {
  constructor() {
    this.settings = {};
    this.models   = [];

    this.modelInput   = el('input', { class: 'inp', type: 'text', placeholder: 'grok-build' });
    this.modelSelect  = null;
    this.cwdInput     = el('input', { class: 'inp', type: 'text', placeholder: '/path/to/working/dir' });
    this.autoApprove  = el('input', { type: 'checkbox' });
    this.themeSelect  = el('select', { class: 'inp', disabled: 'disabled' },
      el('option', { value: 'dark' }, 'dark'),
    );
    this.themeSelect.value = 'dark';

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

      this.field('theme',
        this.themeSelect,
        'dark only for v1. more coming later.'),

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
    this.load();
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
      theme:        this.themeSelect.value,
    };
    this.saveBtn.disabled = true;
    this.setStatus('saving...', 'idle');
    try {
      const updated = await api.patchSettings(body);
      this.settings = updated || body;
      this.setStatus('saved', 'ok');
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
}
