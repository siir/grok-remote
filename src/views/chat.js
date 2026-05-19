// Per-agent conversation pane with live SSE streaming.
//
// Rendering rules (from PROTOCOL.md, frontend section):
//   per turn, in chronological order:
//   1. user bubble
//   2. thinking pane (collapsed) from agent_thought_chunk
//   3. tool_call cards, patched by tool_call_update + tool_call_delta_chunk
//   4. assistant message from agent_message_chunk
//   5. token-usage footer from prompt_complete
//
// Plus: available_commands_update, session_summary_generated,
//       _x.ai/session_notification (toast), error (red banner).

import { api } from '../lib/api.js';
import { openStream } from '../lib/sse.js';
import {
  el,
  renderUserBubble,
  renderAssistantBubble,
  renderThinkingPane,
  renderToolCard,
  renderTokenFooter,
  renderCompactedPill,
  renderErrorBanner,
  renderToast,
} from '../lib/render.js';

export class ChatView {
  constructor() {
    this.agentId = null;
    this.stream  = null;
    this.turns   = []; // each: { user, thinking, tools[], assistant, footer, root }
    this.activeTurn = null;
    this.availableCommands = [];
    this.tabsState = 'conversation';

    this.streamEl  = el('div', { class: 'chat-stream' });
    this.composerEl = this.buildComposer();
    this.tabsEl    = this.buildTabs();
    this.statusEl  = el('div', { class: 'chat-status' });

    this.filesPane = el('div', { class: 'pane pane--files hidden' }, this.buildFilesPlaceholder());
    this.infoPane  = el('div', { class: 'pane pane--info hidden' }, el('div', { class: 'pane-empty' }, 'no agent selected'));

    this.toastHost = el('div', { class: 'toast-host' });

    this.empty = el('div', { class: 'chat-empty' },
      el('div', { class: 'chat-empty-headline' }, 'no agent selected'),
      el('div', { class: 'chat-empty-sub' }, 'pick one from the sidebar or spawn a new one.'),
    );

    this.root = el('section', { class: 'chat' },
      this.tabsEl,
      el('div', { class: 'chat-body' },
        el('div', { class: 'pane pane--conversation' },
          this.statusEl,
          this.streamEl,
          this.composerEl,
        ),
        this.filesPane,
        this.infoPane,
        this.toastHost,
      ),
    );

    this.streamEl.appendChild(this.empty);
    this._setComposerEnabled(false);

    // visibility change -> refresh history on becoming visible
    this._onVisibility = () => {
      if (document.visibilityState === 'visible' && this.agentId) {
        this.refreshHistory().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  mount(parent) {
    parent.appendChild(this.root);
  }

  destroy() {
    this.closeStream();
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  buildTabs() {
    const make = (key, label) => el('button', {
      class: `tab${this.tabsState === key ? ' tab--active' : ''}`,
      dataset: { key },
      onclick: () => this.switchTab(key),
    }, label);
    this.tabBtns = {
      conversation: make('conversation', 'Conversation'),
      files:        make('files',        'Files'),
      info:         make('info',         'Info'),
    };
    return el('nav', { class: 'tabs' },
      this.tabBtns.conversation,
      this.tabBtns.files,
      this.tabBtns.info,
    );
  }

  buildFilesPlaceholder() {
    return el('div', { class: 'pane-empty' },
      'file browser coming soon. for now, use a terminal in the agent cwd.');
  }

  switchTab(key) {
    this.tabsState = key;
    for (const [k, btn] of Object.entries(this.tabBtns)) {
      btn.classList.toggle('tab--active', k === key);
    }
    const convo = this.root.querySelector('.pane--conversation');
    if (convo) convo.classList.toggle('hidden', key !== 'conversation');
    this.filesPane.classList.toggle('hidden', key !== 'files');
    this.infoPane.classList.toggle('hidden', key !== 'info');
  }

  buildComposer() {
    const ta = el('textarea', {
      class: 'composer-input',
      rows: '3',
      placeholder: 'message the agent.  enter to send, shift+enter for newline.  type / for commands.',
      onkeydown: (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          this.send();
        }
      },
      oninput: (ev) => this.maybeShowPalette(ev.target),
    });
    const sendBtn = el('button', {
      class: 'btn btn--primary composer-send',
      onclick: () => this.send(),
    }, 'send');
    const cancelBtn = el('button', {
      class: 'btn btn--ghost composer-cancel',
      onclick: () => this.cancel(),
    }, 'cancel turn');

    this.composerTa = ta;
    this.composerSend = sendBtn;
    this.composerCancel = cancelBtn;
    this.palette = el('div', { class: 'command-palette hidden' });

    return el('div', { class: 'composer' },
      this.palette,
      ta,
      el('div', { class: 'composer-actions' }, cancelBtn, sendBtn),
    );
  }

  maybeShowPalette(ta) {
    const v = ta.value;
    if (!v.startsWith('/')) {
      this.palette.classList.add('hidden');
      this.palette.replaceChildren();
      return;
    }
    const q = v.slice(1).split(/\s/)[0].toLowerCase();
    const matches = this.availableCommands.filter(c => !q || (c.name && c.name.toLowerCase().startsWith(q)));
    if (!matches.length) {
      this.palette.classList.add('hidden');
      this.palette.replaceChildren();
      return;
    }
    this.palette.replaceChildren(...matches.slice(0, 8).map(c =>
      el('button', {
        class: 'command-palette-item',
        onclick: (ev) => {
          ev.preventDefault();
          ta.value = `/${c.name} `;
          ta.focus();
          this.palette.classList.add('hidden');
        },
      },
        el('span', { class: 'cp-name' }, `/${c.name}`),
        c.description ? el('span', { class: 'cp-desc' }, c.description) : null,
      )
    ));
    this.palette.classList.remove('hidden');
  }

  setAvailableCommands(list) {
    if (!Array.isArray(list)) return;
    this.availableCommands = list;
  }

  _setComposerEnabled(enabled) {
    if (!this.composerTa) return;
    this.composerTa.disabled = !enabled;
    this.composerSend.disabled = !enabled;
    this.composerCancel.disabled = enabled; // only enable mid-turn... toggled in send()
  }

  setAgent(agent) {
    // agent: { id, ... } or null
    this.closeStream();
    this.streamEl.replaceChildren();
    this.turns = [];
    this.activeTurn = null;
    this.statusEl.textContent = '';
    this.palette.classList.add('hidden');
    this.palette.replaceChildren();
    this.toastHost.replaceChildren();
    this.composerTa.value = '';

    if (!agent || !agent.id) {
      this.agentId = null;
      this.streamEl.appendChild(this.empty);
      this.infoPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      this._setComposerEnabled(false);
      return;
    }

    this.agentId = agent.id;
    this._setComposerEnabled(true);
    this.composerCancel.disabled = true;

    this.refreshHistory()
      .catch((e) => this.showStatus(`history load failed: ${e.message}`, 'warn'))
      .finally(() => {
        this.openStreamForCurrent();
      });

    this.renderInfo(agent);
  }

  renderInfo(agent) {
    const rows = [
      ['id',     agent.id],
      ['name',   agent.name || '·'],
      ['model',  agent.model || '·'],
      ['status', agent.status || '·'],
      ['cwd',    agent.cwd || '·'],
      ['host',   agent.hostname || '·'],
      ['version',agent.agentVersion || '·'],
      ['lastSeen', agent.lastSeen || agent.last_seen || '·'],
    ];
    this.infoPane.replaceChildren(
      el('div', { class: 'info-grid' },
        ...rows.flatMap(([k, v]) => [
          el('div', { class: 'info-k' }, k),
          el('div', { class: 'info-v' }, String(v)),
        ])
      ),
    );
  }

  async refreshHistory() {
    if (!this.agentId) return;
    try {
      const hist = await api.history(this.agentId);
      // Best-effort: server may return a list of events or a list of turns.
      // We expect an array of SSE-like events: { event, data }.
      const events = Array.isArray(hist) ? hist : (hist && Array.isArray(hist.events) ? hist.events : []);
      if (!events.length) return;
      this.streamEl.replaceChildren();
      this.turns = [];
      this.activeTurn = null;
      for (const ev of events) {
        const name = ev.event || ev.type || ev.name;
        const data = ev.data || ev.payload || ev;
        if (!name) continue;
        this.handleEvent(name, data, { fromHistory: true });
      }
    } catch (e) {
      // backend may not implement history yet
    }
  }

  openStreamForCurrent() {
    if (!this.agentId) return;
    this.showStatus('connecting...', 'idle');
    this.stream = openStream(`/api/agents/${encodeURIComponent(this.agentId)}/stream`, {
      onOpen:  () => this.showStatus('connected', 'ok'),
      onError: () => this.showStatus('stream error · reconnecting', 'warn'),
      onAny:   (name, data) => this.handleEvent(name, data),
    });
  }

  closeStream() {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  showStatus(text, kind) {
    this.statusEl.replaceChildren(
      el('span', { class: `status-pill status-pill--${kind || 'idle'}` }, '·'),
      el('span', { class: 'chat-status-text' }, text),
    );
  }

  showToast(text, kind) {
    const toast = renderToast(text, kind);
    this.toastHost.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast--out');
      setTimeout(() => toast.remove(), 250);
    }, 4200);
  }

  // ── turn machinery ───────────────────────────────────────────────────

  ensureTurn() {
    if (this.activeTurn) return this.activeTurn;
    return this.startTurn('');
  }

  startTurn(userText) {
    const userBubble = renderUserBubble(userText);
    const root = el('div', { class: 'turn' }, userBubble);
    this.streamEl.appendChild(root);
    const turn = {
      user:      userBubble,
      thinking:  null,
      tools:     [],
      assistant: null,
      footer:    null,
      root,
    };
    this.turns.push(turn);
    this.activeTurn = turn;
    this.scrollToBottom();
    return turn;
  }

  endTurn(meta) {
    if (!this.activeTurn) return;
    if (this.activeTurn.thinking) this.activeTurn.thinking.finalize();
    if (this.activeTurn.assistant) this.activeTurn.assistant.finalize();
    const footer = renderTokenFooter(meta || {});
    this.activeTurn.root.appendChild(footer);
    this.activeTurn.footer = footer;
    this.activeTurn = null;
    this.composerCancel.disabled = true;
    this.scrollToBottom();
  }

  scrollToBottom() {
    // smooth-scroll the conversation pane
    this.streamEl.scrollTop = this.streamEl.scrollHeight;
  }

  // ── event dispatch ──────────────────────────────────────────────────

  handleEvent(name, payload, opts) {
    const data = unwrap(payload);
    switch (name) {
      case 'agent_message_chunk':       return this.onMessageChunk(data);
      case 'agent_thought_chunk':       return this.onThoughtChunk(data);
      case 'tool_call':                 return this.onToolCall(data);
      case 'tool_call_update':          return this.onToolCallUpdate(data);
      case 'tool_call_delta_chunk':     return this.onToolCallDelta(data);
      case 'available_commands_update': return this.onAvailableCommands(data);
      case 'session_summary_generated': return this.onSessionSummary(data);
      case 'prompt_complete':           return this.onPromptComplete(data);
      case 'agent_status':              return this.onAgentStatus(data);
      case 'session_notification':      return this.onSessionNotification(data);
      case 'error':                     return this.onError(data);
      default: return;
    }
  }

  onMessageChunk(data) {
    const text = extractText(data);
    if (text == null) return;
    const turn = this.ensureTurn();
    if (!turn.assistant) {
      turn.assistant = renderAssistantBubble();
      turn.root.appendChild(turn.assistant.node);
    }
    turn.assistant.append(text);
    this.scrollToBottom();
  }

  onThoughtChunk(data) {
    const text = extractText(data);
    if (text == null) return;
    const turn = this.ensureTurn();
    if (!turn.thinking) {
      turn.thinking = renderThinkingPane();
      turn.root.appendChild(turn.thinking.node);
    }
    turn.thinking.append(text);
    this.scrollToBottom();
  }

  onToolCall(data) {
    const turn = this.ensureTurn();
    const card = renderToolCard(data);
    turn.tools.push({ id: data.toolCallId, card });
    turn.root.appendChild(card.node);
    this.scrollToBottom();
  }

  onToolCallUpdate(data) {
    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (!turn) return;
    const entry = turn.tools.find(t => t.id === data.toolCallId);
    if (entry) {
      entry.card.applyUpdate(data);
    } else {
      // server might emit an update before we ever saw a tool_call. create one.
      const card = renderToolCard(data);
      turn.tools.push({ id: data.toolCallId, card });
      turn.root.appendChild(card.node);
    }
  }

  onToolCallDelta(data) {
    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (!turn || !turn.tools.length) return;
    // append to most-recent open tool card
    let target = null;
    for (let i = turn.tools.length - 1; i >= 0; i--) {
      const status = turn.tools[i].card.getStatus();
      if (status !== 'completed' && status !== 'failed') { target = turn.tools[i]; break; }
    }
    if (!target) target = turn.tools[turn.tools.length - 1];
    if (data && data.toolCallId) {
      const exact = turn.tools.find(t => t.id === data.toolCallId);
      if (exact) target = exact;
    }
    target.card.appendDelta(data);
    this.scrollToBottom();
  }

  onAvailableCommands(data) {
    const list = (data && data.availableCommands) || data && data.commands || data;
    if (Array.isArray(list)) this.setAvailableCommands(list);
  }

  onSessionSummary(data) {
    const text = (data && (data.summary || data.text)) || '';
    const pill = renderCompactedPill(text);
    this.streamEl.appendChild(pill);
    this.scrollToBottom();
  }

  onPromptComplete(data) {
    const meta = (data && data._meta) || data || {};
    this.endTurn(meta);
  }

  onAgentStatus(data) {
    const status = data && (data.status || data.state);
    if (!status) return;
    if (status === 'running') {
      this.showStatus('agent is running', 'warn');
      this.composerCancel.disabled = false;
    } else if (status === 'idle') {
      this.showStatus('idle', 'ok');
      this.composerCancel.disabled = true;
    } else if (status === 'errored') {
      this.showStatus('errored', 'fail');
    } else if (status === 'killed') {
      this.showStatus('killed', 'fail');
    } else {
      this.showStatus(status, 'idle');
    }
  }

  onSessionNotification(data) {
    const text = (data && (data.message || data.text)) || JSON.stringify(data).slice(0, 200);
    this.showToast(text, 'info');
  }

  onError(data) {
    const text = (data && (data.message || data.error)) || (typeof data === 'string' ? data : JSON.stringify(data));
    const turn = this.activeTurn || this.ensureTurn();
    turn.root.appendChild(renderErrorBanner(text));
    this.scrollToBottom();
  }

  // ── composer actions ────────────────────────────────────────────────

  async send() {
    if (!this.agentId) return;
    const text = this.composerTa.value.trim();
    if (!text) return;
    this.composerTa.value = '';
    this.palette.classList.add('hidden');

    // Start a turn locally and let the SSE stream fill in the rest.
    this.startTurn(text);
    this.composerCancel.disabled = false;

    try {
      await api.prompt(this.agentId, text);
    } catch (e) {
      this.activeTurn && this.activeTurn.root.appendChild(renderErrorBanner(e.message));
      this.endTurn(null);
    }
  }

  async cancel() {
    if (!this.agentId) return;
    try {
      await api.cancel(this.agentId);
      this.showToast('cancel requested', 'warn');
    } catch (e) {
      this.showToast(`cancel failed: ${e.message}`, 'warn');
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function unwrap(payload) {
  // Server unwraps `update`; but some history endpoints may wrap it.
  if (payload && payload.update && typeof payload.update === 'object') return payload.update;
  return payload || {};
}

function extractText(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (payload.content) {
    if (typeof payload.content === 'string') return payload.content;
    if (typeof payload.content.text === 'string') return payload.content.text;
  }
  if (typeof payload.text === 'string') return payload.text;
  return null;
}
