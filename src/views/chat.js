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
import { mountFilesTab, unmountFilesTab } from './files.js';
import attachSlashPalette from '../lib/slash-palette.js';
import { setupImageAttach } from '../lib/attach-images.js';
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
import { copyToClipboard, serializeConversation, serializeResumeCommand } from '../lib/copy.js';

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

    this.filesPane = el('div', { class: 'pane pane--files hidden' });
    this.filesMounted = false;
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
    this._attachComposerExtras();

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
    if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }
    if (this._detachPalette) { try { this._detachPalette(); } catch { /* ignore */ } this._detachPalette = null; }
    if (this.imageAttach) { try { this.imageAttach.destroy(); } catch { /* ignore */ } this.imageAttach = null; }
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
    this.copyConvoBtn = el('button', {
      class: 'tab-action tab-action--copy',
      type: 'button',
      title: 'Copy entire conversation as plain text',
      onclick: () => this.copyConversation(),
    }, 'copy conversation');
    return el('nav', { class: 'tabs' },
      this.tabBtns.conversation,
      this.tabBtns.files,
      this.tabBtns.info,
      el('span', { class: 'tabs-spacer' }),
      this.copyConvoBtn,
    );
  }

  async copyConversation() {
    if (!this.agentId) {
      this.showToast('no agent selected', 'warn');
      return;
    }
    const text = serializeConversation(this.turns, { agent: this.currentAgent || { id: this.agentId } });
    const ok = await copyToClipboard(text);
    if (ok) {
      this.flashBtnLabel(this.copyConvoBtn, 'copied');
      this.showToast('conversation copied to clipboard.', 'info');
    } else {
      this.showToast('copy failed', 'fail');
    }
  }

  flashBtnLabel(btn, tempLabel) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = tempLabel;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 1200);
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

    if (key === 'files') {
      if (this.agentId) {
        mountFilesTab(this.filesPane, { id: this.agentId });
        this.filesMounted = true;
      } else if (!this.filesMounted) {
        this.filesPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      }
    } else if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }

    if (key === 'info') {
      this.renderInfo(this.currentAgent);
    }
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
    });
    const sendBtn = el('button', {
      class: 'btn btn--primary composer-send',
      onclick: () => this.send(),
    }, 'send');
    const cancelBtn = el('button', {
      class: 'btn btn--ghost composer-cancel',
      onclick: () => this.cancel(),
    }, 'cancel turn');

    // Hidden file input used by the "attach image" button.
    const fileInput = el('input', {
      type: 'file',
      class: 'composer-file-input',
      accept: 'image/*',
      multiple: '',
      style: { display: 'none' },
    });
    const attachBtn = el('button', {
      class: 'btn btn--ghost composer-attach',
      title: 'Attach image',
      onclick: (ev) => {
        ev.preventDefault();
        if (!this.imageAttach || !this.imageAttach.isSupported()) {
          this.showToast('This model does not support image input.', 'warn');
          return;
        }
        fileInput.click();
      },
    }, 'attach image');

    // Caption row used to show the slash-command hint after a commit.
    const hintCaption = el('div', { class: 'composer-hint hidden' });

    this.composerTa        = ta;
    this.composerSend      = sendBtn;
    this.composerCancel    = cancelBtn;
    this.composerFileInput = fileInput;
    this.composerAttachBtn = attachBtn;
    this.composerHint      = hintCaption;
    // Kept around (hidden) for back-compat with any leftover CSS hooks; the
    // new slash-palette module creates its own floating panel.
    this.palette = el('div', { class: 'command-palette hidden' });

    return el('div', { class: 'composer' },
      this.palette,
      hintCaption,
      ta,
      el('div', { class: 'composer-actions' },
        attachBtn,
        fileInput,
        cancelBtn,
        sendBtn,
      ),
    );
  }

  _attachComposerExtras() {
    if (this._detachPalette) {
      try { this._detachPalette(); } catch { /* ignore */ }
      this._detachPalette = null;
    }
    if (this.imageAttach) {
      try { this.imageAttach.destroy(); } catch { /* ignore */ }
      this.imageAttach = null;
    }
    if (!this.composerTa) return;

    this._detachPalette = attachSlashPalette({
      textarea: this.composerTa,
      getCommands: () => this.availableCommands,
      onCommit: ({ command, hint }) => {
        if (hint && this.composerHint) {
          this.composerHint.textContent = `usage: /${command.name} ${hint}`;
          this.composerHint.classList.remove('hidden');
        } else if (this.composerHint) {
          this.composerHint.classList.add('hidden');
          this.composerHint.textContent = '';
        }
      },
    });

    this.imageAttach = setupImageAttach({
      container: this.composerEl,
      textarea: this.composerTa,
      fileInput: this.composerFileInput,
      canAttachImages: () => this._canAttachImages(),
      onChange: ({ error }) => {
        if (error) this.showToast(error, 'warn');
        this._syncAttachBtn();
      },
    });
    this._syncAttachBtn();
  }

  _canAttachImages() {
    return !!this._promptCapImage;
  }

  _captureAgentCaps(agent) {
    // Prefer top-level agentCapabilities (exposed by /api/agents); fall back
    // to handshakeMeta.agentCapabilities for older shapes.
    const direct = agent && (agent.agentCapabilities || agent.agent_capabilities);
    let pc = direct && direct.promptCapabilities;
    if (!pc) {
      const meta = agent && (agent.handshakeMeta || agent.handshake_meta);
      const meta_caps = meta && (meta.agentCapabilities || meta.agent_capabilities);
      pc = meta_caps && meta_caps.promptCapabilities;
    }
    if (pc && typeof pc.image === 'boolean') {
      this._promptCapImage = !!pc.image;
    } else {
      // Unknown for now; the agent record will be refreshed via the
      // periodic agents-list poll in main.js, which will call setAgent
      // again with updated caps.
      this._promptCapImage = false;
      // Best-effort: re-fetch shortly after spawn in case the handshake
      // hadn't completed when we mounted.
      if (agent && agent.id) {
        clearTimeout(this._capsRetryTimer);
        this._capsRetryTimer = setTimeout(() => this._refreshCapsLater(agent.id), 1200);
      }
    }
    this._syncAttachBtn();
    if (this.imageAttach) this.imageAttach.refreshSupport();
  }

  async _refreshCapsLater(agentId) {
    if (this.agentId !== agentId) return;
    try {
      const fresh = await api.getAgent(agentId);
      if (!fresh || this.agentId !== agentId) return;
      const pc = (fresh.agentCapabilities && fresh.agentCapabilities.promptCapabilities)
        || (fresh.handshakeMeta && fresh.handshakeMeta.agentCapabilities && fresh.handshakeMeta.agentCapabilities.promptCapabilities)
        || null;
      if (pc && typeof pc.image === 'boolean') {
        const before = !!this._promptCapImage;
        this._promptCapImage = !!pc.image;
        if (before !== this._promptCapImage) {
          this._syncAttachBtn();
          if (this.imageAttach) this.imageAttach.refreshSupport();
        }
      }
    } catch { /* ignore */ }
  }

  _syncAttachBtn() {
    if (!this.composerAttachBtn) return;
    const ok = this._canAttachImages();
    this.composerAttachBtn.disabled = !ok;
    this.composerAttachBtn.classList.toggle('is-disabled', !ok);
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
    if (this.composerHint) {
      this.composerHint.classList.add('hidden');
      this.composerHint.textContent = '';
    }
    if (this.imageAttach) this.imageAttach.clear();
    this._promptCapImage = false;
    this._syncAttachBtn();
    if (agent) this._captureAgentCaps(agent);

    if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }

    if (!agent || !agent.id) {
      this.agentId = null;
      this.streamEl.appendChild(this.empty);
      this.infoPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      this.filesPane.replaceChildren();
      this._setComposerEnabled(false);
      return;
    }

    this.agentId = agent.id;
    this.currentAgent = agent;
    this.latestTotalTokens = (agent && agent.totalTokens) || null;
    this._setComposerEnabled(true);
    this.composerCancel.disabled = true;

    if (this.tabsState === 'files') {
      mountFilesTab(this.filesPane, { id: this.agentId });
      this.filesMounted = true;
    }

    this.refreshHistory()
      .catch((e) => this.showStatus(`history load failed: ${e.message}`, 'warn'))
      .finally(() => {
        this.openStreamForCurrent();
      });

    this.renderInfo(agent);
  }

  renderInfo(agent) {
    if (!agent) {
      this.infoPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      return;
    }
    const sessionId = agent.sessionId || null;
    const cwd       = agent.cwd       || '';
    const totalToks = this.latestTotalTokens != null ? this.latestTotalTokens : (agent.totalTokens != null ? agent.totalTokens : null);

    const truncate = (s, n) => {
      if (!s) return '';
      const str = String(s);
      if (str.length <= n) return str;
      return `${str.slice(0, Math.max(0, n - 1))}...`;
    };
    const copyValueBtn = (val, label) => {
      const btn = el('button', {
        class: 'info-copy',
        type: 'button',
        title: `Copy ${label}`,
        onclick: async () => {
          if (!val) return;
          const ok = await copyToClipboard(val);
          if (ok) {
            this.flashBtnLabel(btn, 'copied');
          }
        },
      }, 'copy');
      if (!val) btn.disabled = true;
      return btn;
    };

    const rows = [
      ['name',     agent.name || '·'],
      ['status',   agent.status || '·'],
      ['model',    agent.model || '·'],
      ['session',  sessionId || 'Pending handshake...', sessionId ? { copy: sessionId, truncated: truncate(sessionId, 32) } : null],
      ['cwd',      cwd || '·',                          cwd       ? { copy: cwd,       truncated: truncate(cwd, 48)       } : null],
      ['hostname', agent.hostname || '·'],
      ['version',  agent.agentVersion || '·'],
      ['agent id', agent.agentId || agent.id || '·'],
      ['instance', agent.agentInstanceId || '·'],
      ['created',  agent.createdAt || agent.created_at || '·'],
      ['lastSeen', agent.lastSeen || agent.last_seen || '·'],
      ['tokens',   totalToks != null ? String(totalToks) : '·'],
    ];

    const grid = el('div', { class: 'info-grid' });
    for (const row of rows) {
      const [k, v, copyOpt] = row;
      grid.appendChild(el('div', { class: 'info-k' }, k));
      if (copyOpt && copyOpt.copy) {
        grid.appendChild(el('div', { class: 'info-v info-v--with-copy' },
          el('span', { class: 'info-v-text', title: copyOpt.copy }, copyOpt.truncated || String(v)),
          copyValueBtn(copyOpt.copy, k),
        ));
      } else {
        grid.appendChild(el('div', { class: 'info-v' }, String(v)));
      }
    }

    // Resume on CLI block
    const resumeText = serializeResumeCommand({ sessionId, cwd });
    const resumeBody = el('pre', { class: 'info-resume-body' }, resumeText);
    const resumeBtn = el('button', {
      class: 'btn btn--ghost info-resume-copy',
      type: 'button',
      onclick: async () => {
        if (!sessionId) return;
        const ok = await copyToClipboard(resumeText);
        if (ok) {
          this.flashBtnLabel(resumeBtn, 'copied');
          this.showToast('resume command copied.', 'info');
        }
      },
    }, 'copy resume command');
    if (!sessionId) resumeBtn.disabled = true;

    const resume = el('div', { class: 'info-resume' },
      el('div', { class: 'info-resume-head' },
        el('span', { class: 'info-resume-title' }, 'Resume on CLI'),
        resumeBtn,
      ),
      resumeBody,
      !sessionId
        ? el('div', { class: 'info-resume-hint' }, 'Session ID not yet assigned. The button enables once the agent finishes its handshake.')
        : null,
    );

    this.infoPane.replaceChildren(grid, resume);
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
      userText:  userText || '',
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
      case 'handshake':                 return this.onHandshake(data);
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

  onHandshake(data) {
    // Agent-manager forwards { meta, agentCapabilities } as the SSE payload.
    const caps = data && (data.agentCapabilities || data.agent_capabilities);
    const pc = caps && caps.promptCapabilities;
    if (pc && typeof pc.image === 'boolean') {
      const before = !!this._promptCapImage;
      this._promptCapImage = !!pc.image;
      if (before !== this._promptCapImage) {
        this._syncAttachBtn();
        if (this.imageAttach) this.imageAttach.refreshSupport();
        // If the new model dropped image support, surface a clear warning.
        const atts = this.imageAttach ? this.imageAttach.getAttachments() : [];
        if (!this._promptCapImage && atts.length) {
          this.showToast('Active model no longer supports image input. Remove attachments to send.', 'warn');
        }
      }
    }
  }

  onSessionSummary(data) {
    const text = (data && (data.summary || data.text)) || '';
    const pill = renderCompactedPill(text);
    this.streamEl.appendChild(pill);
    this.scrollToBottom();
  }

  onPromptComplete(data) {
    const meta = (data && data._meta) || data || {};
    if (meta && (meta.totalTokens != null || meta.total_tokens != null)) {
      this.latestTotalTokens = meta.totalTokens ?? meta.total_tokens;
    }
    // Capture sessionId/cwd from prompt_complete meta if the agent record is
    // missing it (handshake metadata is sometimes delivered out of band).
    if (this.currentAgent) {
      if (meta.sessionId && !this.currentAgent.sessionId) {
        this.currentAgent.sessionId = meta.sessionId;
      }
      if (meta.modelId && !this.currentAgent.model) {
        this.currentAgent.model = meta.modelId;
      }
      // refresh the info pane if visible
      if (this.tabsState === 'info') this.renderInfo(this.currentAgent);
    }
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
    const attachments = this.imageAttach ? this.imageAttach.getAttachments() : [];
    if (!text && !attachments.length) return;

    if (attachments.length && !this._canAttachImages()) {
      this.showToast('This model does not support image input. Remove the attachments first.', 'warn');
      return;
    }

    this.composerTa.value = '';
    if (this.composerHint) {
      this.composerHint.classList.add('hidden');
      this.composerHint.textContent = '';
    }
    this.palette.classList.add('hidden');

    // Start a turn locally and let the SSE stream fill in the rest.
    this.startTurn(text);
    this.composerCancel.disabled = false;

    try {
      await api.prompt(this.agentId, { text, attachments });
      if (this.imageAttach) this.imageAttach.clear();
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
