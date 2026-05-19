// Agents sidebar: list + "new agent" form.
// Owns the sidebar element only. The main pane is owned by chat.js / settings.js.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';

const STATUS_LABEL = {
  idle:         'idle',
  running:      'running',
  errored:      'errored',
  killed:       'killed',
  starting:     'starting',
  disconnected: 'disconnected',
  exited:       'disconnected',
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
    this.error = el('div', { class: 'agents-empty agents-empty--err' });
    this.error.hidden = true;

    this.newBtn = el('button', {
      class: 'agents-new-btn',
      title: 'spawn a new agent (auto-named from the first message)',
      onclick: () => this.spawnNew(),
    }, '+ new');

    this.root = el('aside', { class: 'sidebar' },
      el('div', { class: 'sidebar-head' },
        el('span', { class: 'sidebar-title' }, 'agents'),
        this.newBtn,
      ),
      this.error,
      this.list,
    );
  }

  async spawnNew() {
    if (this._creating) return;
    this._creating = true;
    this.newBtn.disabled = true;
    this.error.hidden = true;
    const prevLabel = this.newBtn.textContent;
    this.newBtn.textContent = 'spawning...';
    try {
      const created = await api.createAgent({});
      if (typeof this.onCreate === 'function') this.onCreate(created);
      await this.refresh();
      if (created && created.id) this.select(created.id);
    } catch (e) {
      this.error.textContent = e.message || 'failed to spawn agent';
      this.error.hidden = false;
    } finally {
      this._creating = false;
      this.newBtn.disabled = false;
      this.newBtn.textContent = prevLabel;
    }
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
      document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: agents }));
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
      const isDisconnected = status === 'disconnected' || status === 'exited';
      const dot = el('span', { class: `agent-dot agent-dot--${status}` });

      const toggleBtn = el('button', {
        class: `agent-link${isDisconnected ? ' agent-link--off' : ''}`,
        title: isDisconnected ? 'connect (resume conversation)' : 'disconnect (stop process, keep history)',
        onclick: async (ev) => {
          ev.stopPropagation();
          toggleBtn.disabled = true;
          try {
            if (isDisconnected) await api.connect(a.id);
            else await api.disconnect(a.id);
            await this.refresh();
          } catch (e) {
            alert(`${isDisconnected ? 'connect' : 'disconnect'} failed: ${e.message}`);
          } finally {
            toggleBtn.disabled = false;
          }
        },
      }, isDisconnected ? 'connect' : 'disconnect');

      const item = el('div', {
        class: `agent-item${isSelected ? ' agent-item--selected' : ''}${isDisconnected ? ' agent-item--off' : ''}`,
        onclick: () => this.select(a.id),
      },
        el('div', { class: 'agent-item-top' },
          dot,
          el('span', { class: 'agent-name' }, a.name || a.id.slice(0, 8)),
          el('button', {
            class: 'agent-kill',
            title: 'delete agent (removes history)',
            onclick: async (ev) => {
              ev.stopPropagation();
              if (!confirm(`Delete agent "${a.name || a.id}"?\nThis removes its history and uploaded files.`)) return;
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
          el('span', { class: 'agent-sep' }, '·'),
          toggleBtn,
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
