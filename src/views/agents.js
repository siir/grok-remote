// Agents sidebar: list + new + star + archive flow.
// Owns the sidebar element only. The main pane is owned by chat.js / settings.js.
//
// Display order in active view:
//   1. starred + active (alphabetical, but starred sort first)
//   2. unstarred + active
// Archived items live under a separate "archived" toggle section.

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
    this.showArchived = false;

    this.activeList   = el('div', { class: 'agents-list' });
    this.archivedList = el('div', { class: 'agents-list agents-list--archived' });
    this.archivedList.hidden = true;

    this.empty = el('div', { class: 'agents-empty' }, 'no agents yet');
    this.error = el('div', { class: 'agents-empty agents-empty--err' });
    this.error.hidden = true;

    this.newBtn = el('button', {
      class: 'agents-new-btn',
      title: 'spawn a new agent (auto-named from the first message)',
      onclick: () => this.spawnNew(),
    }, '+ new');

    this.archivedToggle = el('button', {
      class: 'agents-archived-toggle',
      type: 'button',
      onclick: () => this.toggleArchivedView(),
    }, 'archived (0)');

    this.root = el('aside', { class: 'sidebar' },
      el('div', { class: 'sidebar-head' },
        el('span', { class: 'sidebar-title' }, 'agents'),
        this.newBtn,
      ),
      this.error,
      this.activeList,
      this.archivedToggle,
      this.archivedList,
    );
  }

  toggleArchivedView() {
    this.showArchived = !this.showArchived;
    this.archivedList.hidden = !this.showArchived;
    this.renderArchivedToggle();
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
      this.agents = [];
      this.renderList(e.message);
    }
  }

  renderArchivedToggle() {
    const n = this.agents.filter(a => a.archived).length;
    const label = n === 0 ? 'archived (0)' : `${this.showArchived ? '▼' : '▶'} archived (${n})`;
    this.archivedToggle.textContent = label;
    this.archivedToggle.disabled = n === 0;
  }

  renderList(errorMessage) {
    this.activeList.replaceChildren();
    this.archivedList.replaceChildren();

    if (errorMessage) {
      this.activeList.appendChild(el('div', { class: 'agents-empty agents-empty--err' },
        'backend unreachable'));
      this.renderArchivedToggle();
      return;
    }

    const active   = this.agents.filter(a => !a.archived);
    const archived = this.agents.filter(a =>  a.archived);
    // Starred-first sort within active.
    active.sort((x, y) => {
      const s = (y.starred ? 1 : 0) - (x.starred ? 1 : 0);
      if (s) return s;
      const tx = x.lastSeen || x.createdAt || '';
      const ty = y.lastSeen || y.createdAt || '';
      return ty.localeCompare(tx); // most recent first
    });
    archived.sort((x, y) => {
      const tx = x.archivedAt || x.lastSeen || '';
      const ty = y.archivedAt || y.lastSeen || '';
      return ty.localeCompare(tx);
    });

    if (!active.length) {
      this.activeList.appendChild(this.empty);
    } else {
      for (const a of active) this.activeList.appendChild(this.renderItem(a, false));
    }
    for (const a of archived) this.archivedList.appendChild(this.renderItem(a, true));

    this.renderArchivedToggle();
  }

  renderItem(a, isArchived) {
    const isSelected = a.id === this.selectedId;
    const status = a.status || 'idle';
    const isDisconnected = status === 'disconnected' || status === 'exited';
    const dot = el('span', { class: `agent-dot agent-dot--${status}` });

    // Star toggle (always available).
    const starBtn = el('button', {
      class: `agent-star${a.starred ? ' is-on' : ''}`,
      title: a.starred ? 'unstar' : 'star',
      type: 'button',
      onclick: async (ev) => {
        ev.stopPropagation();
        starBtn.disabled = true;
        try {
          await api.updateAgent(a.id, { starred: !a.starred });
          await this.refresh();
        } catch (e) {
          alert(`star failed: ${e.message}`);
        } finally {
          starBtn.disabled = false;
        }
      },
    }, a.starred ? '★' : '☆');

    // Connect / disconnect (live agents only).
    const toggleBtn = !isArchived ? el('button', {
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
    }, isDisconnected ? 'connect' : 'disconnect') : null;

    // Close button:
    //   active   -> "archive" (soft remove from main view)
    //   archived -> "restore" + "delete forever"
    let closeArea;
    if (!isArchived) {
      const archiveBtn = el('button', {
        class: 'agent-archive',
        type: 'button',
        title: 'archive (move to archived; you can restore or delete later)',
        onclick: async (ev) => {
          ev.stopPropagation();
          archiveBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: true });
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            alert(`archive failed: ${e.message}`);
          } finally {
            archiveBtn.disabled = false;
          }
        },
      }, '×');
      closeArea = archiveBtn;
    } else {
      const restoreBtn = el('button', {
        class: 'agent-restore',
        type: 'button',
        title: 'restore from archive',
        onclick: async (ev) => {
          ev.stopPropagation();
          restoreBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: false });
            await this.refresh();
          } catch (e) {
            alert(`restore failed: ${e.message}`);
          } finally {
            restoreBtn.disabled = false;
          }
        },
      }, 'restore');
      const deleteBtn = el('button', {
        class: 'agent-delete-forever',
        type: 'button',
        title: 'delete forever (removes history + uploads)',
        onclick: async (ev) => {
          ev.stopPropagation();
          if (!confirm(`Delete "${a.name || a.id}" forever?\nThis removes its history and uploaded files. Cannot be undone.`)) return;
          try {
            await api.deleteAgent(a.id);
            if (typeof this.onDelete === 'function') this.onDelete(a.id);
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            alert(`delete failed: ${e.message}`);
          }
        },
      }, 'delete');
      closeArea = el('div', { class: 'agent-archived-actions' }, restoreBtn, deleteBtn);
    }

    const item = el('div', {
      class: [
        'agent-item',
        isSelected     ? 'agent-item--selected' : '',
        isDisconnected ? 'agent-item--off' : '',
        isArchived     ? 'agent-item--archived' : '',
        a.starred      ? 'agent-item--starred' : '',
      ].filter(Boolean).join(' '),
      onclick: () => this.select(a.id),
    },
      el('div', { class: 'agent-item-top' },
        dot,
        starBtn,
        el('span', { class: 'agent-name' }, a.name || a.id.slice(0, 8)),
        closeArea,
      ),
      el('div', { class: 'agent-item-meta' },
        el('span', { class: 'agent-model' }, a.model || '·'),
        el('span', { class: 'agent-sep' }, '·'),
        el('span', { class: `agent-status agent-status--${status}` }, STATUS_LABEL[status] || status),
        toggleBtn ? el('span', { class: 'agent-sep' }, '·') : null,
        toggleBtn,
      ),
      a.cwd ? el('div', { class: 'agent-cwd' }, a.cwd) : null,
    );
    return item;
  }

  select(id) {
    this.selectedId = id;
    this.renderList();
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }
}
