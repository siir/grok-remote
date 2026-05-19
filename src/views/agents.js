// Agents sidebar: list + "new agent" form.
// Owns the sidebar element only. The main pane is owned by chat.js / settings.js.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';

const STATUS_LABEL = {
  idle:     'idle',
  running:  'running',
  errored:  'errored',
  killed:   'killed',
  starting: 'starting',
};

export class AgentsSidebar {
  constructor({ onSelect, onCreate, onDelete }) {
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onDelete = onDelete;
    this.agents = [];
    this.selectedId = null;
    this.pollHandle = null;

    this.list  = el('div', { class: 'agents-list' });
    this.empty = el('div', { class: 'agents-empty' }, 'no agents yet');
    this.newBtn = el('button', {
      class: 'agents-new-btn',
      onclick: () => this.toggleForm(true),
    }, '+ new agent');

    this.form = this.buildForm();
    this.form.style.display = 'none';

    this.root = el('aside', { class: 'sidebar' },
      el('div', { class: 'sidebar-head' },
        el('span', { class: 'sidebar-title' }, 'agents'),
        this.newBtn,
      ),
      this.form,
      this.list,
    );
  }

  buildForm() {
    const nameInput  = el('input', { class: 'inp', type: 'text', placeholder: 'name (optional)' });
    const modelInput = el('input', { class: 'inp', type: 'text', placeholder: 'model (optional)' });
    const cwdInput   = el('input', { class: 'inp', type: 'text', placeholder: 'cwd (optional)' });
    const error      = el('div', { class: 'form-error' });

    const submit = el('button', {
      class: 'btn btn--primary',
      onclick: async (ev) => {
        ev.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          const body = {};
          if (nameInput.value.trim())  body.name  = nameInput.value.trim();
          if (modelInput.value.trim()) body.model = modelInput.value.trim();
          if (cwdInput.value.trim())   body.cwd   = cwdInput.value.trim();
          const created = await api.createAgent(body);
          nameInput.value = '';
          modelInput.value = '';
          cwdInput.value = '';
          this.toggleForm(false);
          if (typeof this.onCreate === 'function') this.onCreate(created);
          await this.refresh();
          if (created && created.id) this.select(created.id);
        } catch (e) {
          error.textContent = e.message || 'failed to create agent';
        } finally {
          submit.disabled = false;
        }
      },
    }, 'spawn');

    const cancel = el('button', {
      class: 'btn btn--ghost',
      onclick: (ev) => { ev.preventDefault(); this.toggleForm(false); },
    }, 'cancel');

    return el('form', { class: 'agents-form' },
      nameInput,
      modelInput,
      cwdInput,
      error,
      el('div', { class: 'agents-form-actions' }, submit, cancel),
    );
  }

  toggleForm(show) {
    this.form.style.display = show ? '' : 'none';
  }

  mount(parent) {
    parent.appendChild(this.root);
    this.refresh();
    this.startPolling();
  }

  startPolling() {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = setInterval(() => this.refresh(), 4000);
  }

  stopPolling() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  async refresh() {
    try {
      const data = await api.listAgents();
      const agents = Array.isArray(data) ? data : (data && Array.isArray(data.agents) ? data.agents : []);
      this.agents = agents;
      this.renderList();
    } catch (e) {
      // backend not up: show empty state, no crash
      this.agents = [];
      this.renderList(e.message);
    }
  }

  renderList(errorMessage) {
    this.list.replaceChildren();
    if (errorMessage) {
      this.list.appendChild(el('div', { class: 'agents-empty agents-empty--err' },
        'backend unreachable'));
      return;
    }
    if (!this.agents.length) {
      this.list.appendChild(this.empty);
      return;
    }
    for (const a of this.agents) {
      const isSelected = a.id === this.selectedId;
      const status = a.status || 'idle';
      const dot = el('span', { class: `agent-dot agent-dot--${status}` });
      const item = el('div', {
        class: `agent-item${isSelected ? ' agent-item--selected' : ''}`,
        onclick: () => this.select(a.id),
      },
        el('div', { class: 'agent-item-top' },
          dot,
          el('span', { class: 'agent-name' }, a.name || a.id.slice(0, 8)),
          el('button', {
            class: 'agent-kill',
            title: 'delete agent',
            onclick: async (ev) => {
              ev.stopPropagation();
              if (!confirm(`Delete agent ${a.name || a.id}?`)) return;
              try {
                await api.deleteAgent(a.id);
                if (typeof this.onDelete === 'function') this.onDelete(a.id);
                if (this.selectedId === a.id) this.selectedId = null;
                await this.refresh();
              } catch (e) {
                alert(`delete failed: ${e.message}`);
              }
            },
          }, '×'),
        ),
        el('div', { class: 'agent-item-meta' },
          el('span', { class: 'agent-model' }, a.model || '·'),
          el('span', { class: 'agent-sep' }, '·'),
          el('span', { class: `agent-status agent-status--${status}` }, STATUS_LABEL[status] || status),
        ),
        a.cwd ? el('div', { class: 'agent-cwd' }, a.cwd) : null,
      );
      this.list.appendChild(item);
    }
  }

  select(id) {
    this.selectedId = id;
    this.renderList();
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }
}
