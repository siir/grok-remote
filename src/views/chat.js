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
import { mountTraceTab, unmountTraceTab } from './trace.js';
import { mountScoped as mountFlowTab, unmount as unmountFlowTab } from './system/flow.js';
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
import { iconHtml } from '../lib/icons.js';
import { fmtTokens } from '../lib/format.js';

export class ChatView {
  constructor() {
    this.agentId = null;
    this.stream  = null;
    this.turns   = []; // each: { user, thinking, tools[], assistant, footer, root }
    this.activeTurn = null;
    this.availableCommands = [];
    this.tabsState = 'conversation';

    // Lazy cache of known skill names (set of strings). Populated on first
    // user message that starts with `/`. Drives the "invoked skill" banner
    // we drop above turns that hit a /name match.
    this._knownSkills = null;
    this._skillsPromise = null;

    this.streamEl  = el('div', { class: 'chat-stream' });
    this.composerEl = this.buildComposer();
    this.tabsEl    = this.buildTabs();
    this.statusEl  = el('div', { class: 'chat-status' });

    this.filesPane = el('div', { class: 'pane pane--files hidden' });
    this.filesMounted = false;
    this.infoPane  = el('div', { class: 'pane pane--info hidden' }, el('div', { class: 'pane-empty' }, 'no agent selected'));
    this.tracePane = el('div', { class: 'pane pane--trace hidden' });
    this.traceMounted = false;
    this.flowPane = el('div', { class: 'pane pane--flow hidden' });
    this.flowMounted = false;

    this.toastHost = el('div', { class: 'toast-host' });

    // Settings drawer: slides in from the right of the chat. Built lazily
    // when the user clicks the gear icon so the DOM cost is zero otherwise.
    this.settingsDrawer = null;
    this.settingsDrawerOpen = false;
    this._modelSuggestions = null;

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
        this.tracePane,
        this.flowPane,
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

    // Sidebar pushes fresh agent records into the chat view on each poll
    // tick. Pick out the one matching our active agent so the chat header,
    // info tab, and connect/disconnect button reflect live state.
    this._onAgentsRefresh = (ev) => {
      if (!this.agentId) return;
      const list = (ev && ev.detail) || [];
      const a = list.find(x => x && x.id === this.agentId);
      if (a) this.applyAgentRefresh(a);
    };
    document.addEventListener('grok-remote:agents-refresh', this._onAgentsRefresh);

    // Settings changes (e.g. debug toggle) come in via this custom event.
    this._onSettingsChange = (ev) => this.applySettings((ev && ev.detail) || {});
    window.addEventListener('grok-remote:settings-change', this._onSettingsChange);
    // Pull initial settings so the debug button surfaces if already enabled.
    api.getSettings().then((s) => this.applySettings(s || {})).catch(() => {});
  }

  applySettings(s) {
    const debug = !!s.debug;
    if (this.composerDebugBtn) this.composerDebugBtn.hidden = !debug;
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
    if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
    }
    if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
    }
    if (this._detachPalette) { try { this._detachPalette(); } catch { /* ignore */ } this._detachPalette = null; }
    if (this.imageAttach) { try { this.imageAttach.destroy(); } catch { /* ignore */ } this.imageAttach = null; }
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onAgentsRefresh) {
      document.removeEventListener('grok-remote:agents-refresh', this._onAgentsRefresh);
      this._onAgentsRefresh = null;
    }
    if (this._onSettingsChange) {
      window.removeEventListener('grok-remote:settings-change', this._onSettingsChange);
      this._onSettingsChange = null;
    }
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
      trace:        make('trace',        'Trace'),
      flow:         make('flow',         'Flow'),
    };
    this.starBtn = el('button', {
      class: 'chat-star',
      type: 'button',
      title: 'Star this conversation',
      'aria-label': 'star conversation',
      onclick: () => this.toggleStar(),
    }, '☆');
    this.settingsBtn = el('button', {
      class: 'chat-settings',
      type: 'button',
      title: 'Per-conversation grok settings (model, reasoning effort, rules, ...)',
      'aria-label': 'open settings drawer',
      onclick: () => this.toggleSettingsDrawer(),
    }, '⚙');
    this.connectBtn = el('button', {
      class: 'tab-action tab-action--toggle',
      type: 'button',
      title: 'Disconnect: stop the agent process but keep the conversation.',
      onclick: () => this.toggleConnection(),
    }, 'disconnect');
    this.copyConvoBtn = el('button', {
      class: 'tab-action tab-action--copy',
      type: 'button',
      title: 'Copy entire conversation as plain text',
      onclick: () => this.copyConversation(),
    }, 'copy conversation');
    this.tokensPill = el('span', { class: 'tab-tokens', hidden: true });
    this.inflightPill = el('span', { class: 'tab-inflight', hidden: true });
    return el('nav', { class: 'tabs' },
      this.tabBtns.conversation,
      this.tabBtns.files,
      this.tabBtns.info,
      this.tabBtns.trace,
      this.tabBtns.flow,
      el('span', { class: 'tabs-spacer' }),
      this.inflightPill,
      this.tokensPill,
      this.starBtn,
      this.settingsBtn,
      this.connectBtn,
      this.copyConvoBtn,
    );
  }

  _renderInflightPill() {
    const n = this.currentAgent && this.currentAgent.inFlight;
    if (typeof n === 'number' && n > 0) {
      this.inflightPill.hidden = false;
      this.inflightPill.replaceChildren(
        el('span', { class: 'tab-inflight-dot' }),
        document.createTextNode(`${n} tool${n === 1 ? '' : 's'}`),
      );
      this.inflightPill.title = `${n} tool call${n === 1 ? '' : 's'} in flight`;
    } else {
      this.inflightPill.hidden = true;
      this.inflightPill.replaceChildren();
    }
  }

  _renderTokensPill() {
    // Prefer the live value from prompt_complete / streaming updates over the
    // snapshot we got at setAgent time.
    const live = (typeof this.latestTotalTokens === 'number') ? this.latestTotalTokens : null;
    const snap = this.currentAgent && this.currentAgent.totalTokens;
    const t = (typeof live === 'number' && live > 0) ? live : (typeof snap === 'number' ? snap : 0);
    if (typeof t === 'number' && t > 0) {
      this.tokensPill.hidden = false;
      this.tokensPill.textContent = fmtTokens(t) + ' tok';
      this.tokensPill.title = `${t.toLocaleString()} tokens in context`;
    } else {
      this.tokensPill.hidden = true;
      this.tokensPill.textContent = '';
    }
  }

  async toggleStar() {
    if (!this.agentId) return;
    const cur = !!(this.currentAgent && this.currentAgent.starred);
    this.starBtn.disabled = true;
    try {
      const updated = await api.updateAgent(this.agentId, { starred: !cur });
      this.applyAgentRefresh(updated);
    } catch (e) {
      this.showToast(`star failed: ${e.message}`, 'warn');
    } finally {
      this.starBtn.disabled = false;
    }
  }

  _syncStarBtn() {
    if (!this.starBtn) return;
    const on = !!(this.currentAgent && this.currentAgent.starred);
    this.starBtn.classList.toggle('is-on', on);
    this.starBtn.textContent = on ? '★' : '☆';
    this.starBtn.title = on ? 'Unstar this conversation' : 'Star this conversation';
  }

  async toggleConnection() {
    if (!this.agentId) return;
    const a = this.currentAgent;
    const disconnected = !!(a && (a.status === 'disconnected' || a.status === 'exited'));
    this.connectBtn.disabled = true;
    try {
      if (disconnected) {
        await api.connect(this.agentId);
        this.showToast('connecting...', 'info');
      } else {
        await api.disconnect(this.agentId);
        this.showToast('disconnected; sending a message will reconnect.', 'info');
      }
    } catch (e) {
      this.showToast(`${disconnected ? 'connect' : 'disconnect'} failed: ${e.message}`, 'warn');
    } finally {
      this.connectBtn.disabled = false;
      // The sidebar's 4 s poll will refresh state shortly; force one quick
      // refresh so the chat header label updates immediately.
      setTimeout(() => {
        api.getAgent(this.agentId).then((fresh) => this.applyAgentRefresh(fresh)).catch(() => {});
      }, 500);
    }
  }

  applyAgentRefresh(a) {
    if (!a || a.id !== this.agentId) return;
    this.currentAgent = a;
    this._syncConnectBtn();
    this._syncStarBtn();
    // Re-render info tab if visible so status/sessionId etc. stay current.
    if (this.tabsState === 'info') this.renderInfo(a);
    // Keep the drawer's "reconnect to apply" notice in sync with status.
    if (this.settingsDrawerOpen) this._updateSettingsNotice(a);
    this._renderTokensPill();
    this._renderInflightPill();
  }

  _syncConnectBtn() {
    if (!this.connectBtn) return;
    const a = this.currentAgent;
    const disconnected = !!(a && (a.status === 'disconnected' || a.status === 'exited'));
    this.connectBtn.textContent = disconnected ? 'connect' : 'disconnect';
    this.connectBtn.classList.toggle('tab-action--off', disconnected);
    this.connectBtn.title = disconnected
      ? 'Reconnect: resume the conversation in a fresh agent process.'
      : 'Disconnect: stop the agent process but keep the conversation.';
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
    this.tracePane.classList.toggle('hidden', key !== 'trace');
    this.flowPane.classList.toggle('hidden', key !== 'flow');

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

    // Trace tab: always re-fetch and re-render on every open. The mount
    // function unmounts any prior trace state first, so this is safe.
    if (key === 'trace') {
      if (this.agentId) {
        mountTraceTab(this.tracePane, this.currentAgent || { id: this.agentId });
        this.traceMounted = true;
      } else {
        this.tracePane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      }
    } else if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
    }

    // Flow tab: scoped to just this conversation's agent. Lazily mounts
    // the same ReactFlow component as the global #/flow page but with a
    // filterIds prop so only this agent's node + tool-call satellites show.
    if (key === 'flow') {
      if (this.agentId) {
        mountFlowTab(this.flowPane, [this.agentId]);
        this.flowMounted = true;
      } else {
        this.flowPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      }
    } else if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
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
      title: 'Attach image (saved to agent uploads/ folder)',
      onclick: (ev) => { ev.preventDefault(); fileInput.click(); },
    }, 'attach image');

    const debugBtn = el('button', {
      class: 'btn btn--ghost composer-debug',
      type: 'button',
      title: 'Preview the exact JSON payload that will be sent (composer + attachments), plus the last server-composed prompt if one exists.',
      onclick: (ev) => { ev.preventDefault(); this.openPayloadInspector(); },
    }, '{ payload }');
    // Hidden by default; surfaced when settings.debug is true.
    debugBtn.hidden = true;
    this.composerDebugBtn = debugBtn;

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
        debugBtn,
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

  // Lazy-load the set of known skill names. We use it to decorate user
  // messages that start with `/<name>` matching a real skill. Cached for
  // the lifetime of this ChatView instance.
  async _loadSkills() {
    if (this._knownSkills) return this._knownSkills;
    if (this._skillsPromise) return this._skillsPromise;
    this._skillsPromise = (async () => {
      try {
        const data = await api.skills.list();
        const set = new Set();
        for (const s of ((data && data.skills) || [])) {
          if (s && typeof s.name === 'string' && s.name) set.add(s.name);
        }
        this._knownSkills = set;
        return set;
      } catch {
        this._knownSkills = new Set();
        return this._knownSkills;
      }
    })();
    return this._skillsPromise;
  }

  // Attach an "invoked skill" banner to the turn root when the user
  // message starts with /name and `name` matches a known skill. Banner
  // links to #/skills so the user can jump straight to the skill page.
  _decorateSkill(turn) {
    if (!turn || !turn.userText) return;
    const m = turn.userText.match(/^\s*\/([A-Za-z][\w-]*)\b/);
    if (!m) return;
    const name = m[1];
    Promise.resolve(this._knownSkills || this._loadSkills()).then((set) => {
      if (!set || !set.has(name)) return;
      if (turn._skillBanner) return;
      const banner = el('div', { class: 'skill-banner', title: 'invoked skill (click to open the Skills page)' });
      banner.innerHTML = `
        <span class="skill-banner-ico">${iconHtml('skills')}</span>
        <span class="skill-banner-label">invoked skill</span>
        <a class="skill-banner-name" href="#/skills">/${name}</a>
      `;
      turn._skillBanner = banner;
      // Banner sits ABOVE the user bubble so the chronology reads:
      //   skill chip → user message → assistant turn
      turn.root.insertBefore(banner, turn.user);
    });
  }

  _captureAgentCaps(agent) {
    // Images are now always allowed: the backend saves attachments to the
    // agent's uploads/ folder, so any model can use them via its own tools.
    // We still track the model's native image capability for informational
    // purposes (Info tab), but it no longer gates the attach button.
    this._promptCapImage = true;
    void agent;
    this._syncAttachBtn();
    if (this.imageAttach) this.imageAttach.refreshSupport();
  }

  _syncAttachBtn() {
    if (!this.composerAttachBtn) return;
    this.composerAttachBtn.disabled = false;
    this.composerAttachBtn.classList.remove('is-disabled');
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
    // Fire-and-forget skill cache warmup so the banner can paint as soon
    // as a /name message lands. Harmless if the agent has none.
    this._loadSkills();
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
    if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
      this.tracePane.replaceChildren();
    }
    if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
      this.flowPane.replaceChildren();
    }

    if (!agent || !agent.id) {
      this.agentId = null;
      this.currentAgent = null;
      this.streamEl.appendChild(this.empty);
      this.infoPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      this.filesPane.replaceChildren();
      this._setComposerEnabled(false);
      // Hide the star + connect buttons until an agent is loaded.
      if (this.starBtn)     this.starBtn.hidden = true;
      if (this.settingsBtn) this.settingsBtn.hidden = true;
      if (this.connectBtn)  this.connectBtn.hidden = true;
      if (this.tokensPill)  this.tokensPill.hidden = true;
      if (this.inflightPill) this.inflightPill.hidden = true;
      this.closeSettingsDrawer();
      return;
    }
    if (this.starBtn)     this.starBtn.hidden = false;
    if (this.settingsBtn) this.settingsBtn.hidden = false;
    if (this.connectBtn)  this.connectBtn.hidden = false;

    this.agentId = agent.id;
    this.currentAgent = agent;
    this.latestTotalTokens = (agent && agent.totalTokens) || null;
    this._setComposerEnabled(true);
    this.composerCancel.disabled = true;
    this._syncConnectBtn();
    this._renderTokensPill();
    this._renderInflightPill();
    this._syncStarBtn();

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

    const publishSection = this._buildPublishSection(sessionId);

    this.infoPane.replaceChildren(grid, resume, publishSection);
  }

  // Wraps `grok share <sessionId>` via POST /api/agents/:id/publish. The
  // button is disabled until the agent has a sessionId, mirroring the
  // resume block above. Result + warning text are rendered in-place.
  _buildPublishSection(sessionId) {
    const wrap = el('div', { class: 'info-publish' });
    const head = el('div', { class: 'info-publish-head' },
      el('span', { class: 'info-publish-title' }, 'Publish (share)'),
    );
    const warn = el('div', { class: 'info-publish-warn' },
      'This uploads the entire session (prompts, tool calls, assistant messages) to xAI.',
      ' Do not share if it contains secrets, credentials, or private code.',
    );

    const resultHost = el('div', { class: 'info-publish-result' });
    const publishBtn = el('button', {
      class: 'btn btn--ghost info-publish-btn',
      type: 'button',
      onclick: () => this._handlePublish(publishBtn, resultHost),
    }, 'publish session');
    if (!sessionId) {
      publishBtn.disabled = true;
      publishBtn.title = 'Session ID not yet assigned.';
    }
    head.appendChild(publishBtn);

    wrap.appendChild(head);
    wrap.appendChild(warn);
    if (!sessionId) {
      wrap.appendChild(el('div', { class: 'info-publish-hint' },
        'Available once the agent finishes its handshake and has a session id.'));
    }
    wrap.appendChild(resultHost);
    return wrap;
  }

  async _handlePublish(btn, resultHost) {
    if (!this.agentId || !btn) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'publishing...';
    resultHost.replaceChildren();
    try {
      const data = await api.share(this.agentId);
      const url = data && data.url;
      if (!url) throw new Error('server did not return a URL');
      const copyBtn = el('button', {
        class: 'info-copy',
        type: 'button',
        title: 'Copy share URL',
        onclick: async () => {
          const ok = await copyToClipboard(url);
          if (ok) {
            this.flashBtnLabel(copyBtn, 'copied');
            this.showToast('share URL copied.', 'info');
          }
        },
      }, 'copy');
      const link = el('a', {
        class: 'info-publish-url',
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, url);
      resultHost.appendChild(el('div', { class: 'info-publish-result-row' }, link, copyBtn));
    } catch (e) {
      resultHost.appendChild(el('div', { class: 'info-publish-error' },
        `publish failed: ${e && e.message ? e.message : String(e)}`));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async refreshHistory({ all = false, turns = 50 } = {}) {
    if (!this.agentId) return;
    this._historyAll = !!all;
    try {
      const hist = await api.history(this.agentId, { turns, all });
      const events = (hist && Array.isArray(hist.events)) ? hist.events : [];
      this.streamEl.replaceChildren();
      this.turns = [];
      this.activeTurn = null;
      // If there are older turns we didn't load, show a banner at the top.
      const total = (hist && hist.totalTurns) || 0;
      const returned = (hist && hist.returnedTurns) || 0;
      if (!all && total > returned && returned > 0) {
        this.streamEl.appendChild(this._buildLoadEarlierBanner(total - returned));
      }
      for (const ev of events) {
        const name = ev.event || ev.type || ev.name;
        const data = ev.data || ev.payload || ev;
        if (!name) continue;
        this.handleEvent(name, data, { fromHistory: true });
      }
      // Scroll the stream to the bottom after a history load.
      requestAnimationFrame(() => {
        this.streamEl.scrollTop = this.streamEl.scrollHeight;
      });
    } catch (e) {
      // backend may not implement history yet
    }
  }

  _buildLoadEarlierBanner(missingCount) {
    const btn = el('button', {
      class: 'history-load-more-btn',
      type: 'button',
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = 'loading...';
        await this.refreshHistory({ all: true });
      },
    }, `load all earlier turns (${missingCount} more)`);
    return el('div', { class: 'history-load-more' }, btn);
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
    // Decorate retroactively once the skill set is loaded. Idempotent.
    this._decorateSkill(turn);
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
      this._renderTokensPill();
    this._renderInflightPill();
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

    // Snapshot the payload for the inspector before clearing the composer.
    this._lastPayload = this._buildPayloadSnapshot(text, attachments);
    this._lastServerEcho = null;

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
      const resp = await api.prompt(this.agentId, { text, attachments });
      this._lastServerEcho = resp && typeof resp === 'object' ? resp : null;
      if (this.imageAttach) this.imageAttach.clear();
    } catch (e) {
      this.activeTurn && this.activeTurn.root.appendChild(renderErrorBanner(e.message));
      this.endTurn(null);
    }
  }

  _buildPayloadSnapshot(text, attachments) {
    // Build the same body shape api.prompt would send, so the inspector
    // shows the exact wire payload (base64 included).
    const safeAttachments = (attachments || []).map(a => ({
      kind:       a.kind || 'image',
      name:       a.name || null,
      mimeType:   a.mimeType || null,
      size:       a.size || null,
      dataBase64: a.dataBase64 || '',
    }));
    const body = { text };
    if (safeAttachments.length) body.attachments = safeAttachments;
    return {
      method:  'POST',
      url:     `/api/agents/${this.agentId}/prompt`,
      body,
      sentAt:  new Date().toISOString(),
    };
  }

  openPayloadInspector() {
    // Build a "current draft" snapshot from the composer + attachments so
    // the inspector works both before send (preview) and after send (echo).
    const text = this.composerTa ? this.composerTa.value : '';
    const attachments = this.imageAttach ? this.imageAttach.getAttachments() : [];
    const draftPayload = (text.trim() || attachments.length)
      ? this._buildPayloadSnapshot(text.trim(), attachments)
      : null;

    if (this._payloadModal) {
      try { this._payloadModal.remove(); } catch { /* ignore */ }
      this._payloadModal = null;
    }

    const close = () => {
      if (this._payloadModal) {
        try { this._payloadModal.remove(); } catch { /* ignore */ }
        this._payloadModal = null;
      }
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    const dumpBlock = (title, value, opts = {}) => {
      const pretty = value == null ? 'null' : JSON.stringify(value, null, 2);
      const view = pretty.length > 20000 && !opts.full
        ? this._truncateBase64(pretty)
        : pretty;
      const pre = el('pre', { class: 'payload-pre' }, view);
      const copyBtn = el('button', {
        class: 'btn btn--ghost payload-copy',
        type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(pretty);
            this.showToast('payload copied', 'info');
          } catch (e) {
            this.showToast(`copy failed: ${e.message}`, 'warn');
          }
        },
      }, 'copy');
      return el('section', { class: 'payload-section' },
        el('header', { class: 'payload-section-head' },
          el('h3', null, title),
          copyBtn,
        ),
        pre,
      );
    };

    const sections = [];
    if (draftPayload) {
      sections.push(dumpBlock(
        'composer draft (would be sent on click)',
        draftPayload,
      ));
    }
    if (this._lastPayload) {
      sections.push(dumpBlock(
        'last sent request body',
        this._lastPayload,
      ));
    }
    if (this._lastServerEcho) {
      sections.push(dumpBlock(
        'server response (echoed back, after attachment processing)',
        this._lastServerEcho,
      ));
    }
    if (!sections.length) {
      sections.push(el('div', { class: 'payload-empty' },
        'No payload yet. Type or attach something, then click here to preview,',
        ' or send a message and reopen this panel to see the actual request.'));
    }

    const closeBtn = el('button', {
      class: 'btn btn--ghost payload-close',
      type: 'button',
      onclick: close,
    }, 'close');

    const modal = el('div', { class: 'payload-modal' },
      el('div', { class: 'payload-modal-backdrop', onclick: close }),
      el('div', { class: 'payload-modal-card' },
        el('header', { class: 'payload-modal-head' },
          el('h2', null, 'Outgoing prompt payload'),
          el('div', { class: 'payload-modal-hint' },
            'Base64 image data is truncated in the view; the copy button copies the FULL payload to your clipboard.'),
          closeBtn,
        ),
        el('div', { class: 'payload-modal-body' }, ...sections),
      ),
    );
    this._payloadModal = modal;
    document.body.appendChild(modal);
  }

  _truncateBase64(pretty) {
    // Replace long dataBase64 strings inline with a "<NNN bytes>" placeholder
    // so the panel stays readable. The copy button still copies the original.
    return pretty.replace(/"dataBase64": "([A-Za-z0-9+/=]{200,})"/g, (_m, b64) => {
      return `"dataBase64": "<base64, ${b64.length} chars; copied in full when you click copy>"`;
    });
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

  // ── settings drawer ─────────────────────────────────────────────────

  toggleSettingsDrawer() {
    if (this.settingsDrawerOpen) this.closeSettingsDrawer();
    else this.openSettingsDrawer();
  }

  openSettingsDrawer() {
    if (!this.agentId) return;
    if (!this.settingsDrawer) this._buildSettingsDrawer();
    this._populateSettingsDrawer(this.currentAgent || {});
    this.settingsDrawer.classList.add('chat-settings-drawer--open');
    this.settingsDrawerOpen = true;
    // Fetch model suggestions lazily on first open. Best-effort.
    if (this._modelSuggestions == null) {
      this._modelSuggestions = [];
      api.systemModels.get()
        .then((r) => {
          const items = (r && Array.isArray(r.items)) ? r.items : [];
          this._modelSuggestions = items.map(i => i.id).filter(Boolean);
          this._renderModelDatalist();
        })
        .catch(() => { /* leave list empty */ });
    } else {
      this._renderModelDatalist();
    }
  }

  closeSettingsDrawer() {
    if (!this.settingsDrawer) return;
    this.settingsDrawer.classList.remove('chat-settings-drawer--open');
    this.settingsDrawerOpen = false;
  }

  _buildSettingsDrawer() {
    // Each row is built as a small helper so we can wire .value into a map
    // for save-time collection without manually plumbing each one.
    const fields = {};

    const labeledRow = (key, labelText, input, hintText) => {
      fields[key] = input;
      const row = el('div', { class: 'sd-row' },
        el('label', { class: 'sd-label' }, labelText),
        input,
        hintText ? el('div', { class: 'sd-hint' }, hintText) : null,
      );
      return row;
    };

    const modelInput = el('input', {
      class: 'sd-input',
      type: 'text',
      list: 'chat-settings-model-list',
      placeholder: 'e.g. grok-code-fast-1 (leave blank for default)',
    });
    const reasoningSelect = el('select', { class: 'sd-input' },
      el('option', { value: '' }, 'default'),
      el('option', { value: 'none' }, 'none'),
      el('option', { value: 'minimal' }, 'minimal'),
      el('option', { value: 'low' }, 'low'),
      el('option', { value: 'medium' }, 'medium'),
      el('option', { value: 'high' }, 'high'),
      el('option', { value: 'xhigh' }, 'xhigh'),
    );
    const systemPromptTa = el('textarea', {
      class: 'sd-input sd-textarea',
      rows: '4',
      placeholder: 'replace the agent system prompt entirely (leave blank to keep default).',
    });
    const rulesTa = el('textarea', {
      class: 'sd-input sd-textarea',
      rows: '4',
      placeholder: 'extra rules appended to the system prompt (one per line is fine).',
    });
    const toolsInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'comma-separated, e.g. read_file,grep,list_dir',
    });
    const disallowedInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'comma-separated, e.g. web_search,run_terminal_cmd',
    });
    const allowTa = el('textarea', {
      class: 'sd-input sd-textarea',
      rows: '3',
      placeholder: 'one rule per line, e.g. Bash(npm*)',
    });
    const denyTa = el('textarea', {
      class: 'sd-input sd-textarea',
      rows: '3',
      placeholder: 'one rule per line, e.g. Bash(rm*)  (deny wins over allow)',
    });

    const worktreeCheckbox = el('input', {
      class: 'sd-checkbox',
      type: 'checkbox',
    });
    const worktreeName = el('input', {
      class: 'sd-input sd-input--inline',
      type: 'text',
      placeholder: 'optional name',
    });
    const worktreeRow = el('div', { class: 'sd-row' },
      el('label', { class: 'sd-label' },
        worktreeCheckbox,
        el('span', null, ' Run inside a new git worktree'),
      ),
      worktreeName,
      el('div', { class: 'sd-hint' },
        'Equivalent to `-w` (or `-w <name>` when filled).'),
    );
    fields.worktree = worktreeCheckbox;
    fields.worktreeName = worktreeName;

    const sandboxInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'sandbox profile name',
    });

    const alwaysApproveCheckbox = el('input', {
      class: 'sd-checkbox',
      type: 'checkbox',
    });
    alwaysApproveCheckbox.checked = true;
    const alwaysApproveRow = el('div', { class: 'sd-row' },
      el('label', { class: 'sd-label' },
        alwaysApproveCheckbox,
        el('span', null, ' Always approve tool calls (YOLO)'),
      ),
      el('div', { class: 'sd-hint' },
        'On by default. Disabling it makes the agent prompt for permission before every tool call.'),
    );
    fields.alwaysApprove = alwaysApproveCheckbox;

    const dataList = el('datalist', { id: 'chat-settings-model-list' });
    this._modelDatalist = dataList;

    const saveBtn = el('button', {
      class: 'btn btn--primary sd-save',
      type: 'button',
      onclick: () => this._submitSettingsDrawer(),
    }, 'save');
    const resetBtn = el('button', {
      class: 'btn btn--ghost sd-reset',
      type: 'button',
      title: 'Clear all per-conversation settings (revert to defaults)',
      onclick: () => this._clearSettingsDrawer(),
    }, 'clear all');
    const closeBtn = el('button', {
      class: 'btn btn--ghost sd-close',
      type: 'button',
      onclick: () => this.closeSettingsDrawer(),
    }, 'close');

    const notice = el('div', { class: 'sd-notice hidden' });
    this._sdNotice = notice;

    const body = el('div', { class: 'sd-body' },
      labeledRow('model', 'Model', modelInput, 'Top-level `-m` override. Blank = whatever the CLI defaults to.'),
      labeledRow('reasoningEffort', 'Reasoning effort', reasoningSelect, 'Maps to `--reasoning-effort`.'),
      labeledRow('systemPromptOverride', 'System prompt override', systemPromptTa, 'Maps to `--system-prompt-override`. Replaces the entire system prompt.'),
      labeledRow('rules', 'Rules', rulesTa, 'Maps to `--rules`. Appended after the system prompt.'),
      labeledRow('tools', 'Allowed tools', toolsInput, 'Maps to `--tools`. Comma-separated; turns off default tool injection.'),
      labeledRow('disallowedTools', 'Disallowed tools', disallowedInput, 'Maps to `--disallowed-tools`. Comma-separated.'),
      labeledRow('allow', 'Permission allow rules', allowTa, 'Maps to repeated `--allow`. One rule per line.'),
      labeledRow('deny', 'Permission deny rules', denyTa, 'Maps to repeated `--deny`. One rule per line. Deny wins over allow.'),
      worktreeRow,
      labeledRow('sandbox', 'Sandbox profile', sandboxInput, 'Maps to `--sandbox`.'),
      alwaysApproveRow,
      dataList,
    );

    const head = el('header', { class: 'sd-head' },
      el('h3', { class: 'sd-title' }, 'Conversation settings'),
      el('div', { class: 'sd-sub' },
        'Per-conversation overrides for ', el('code', null, 'grok'),
        ' top-level flags. Applied on the next time this agent (re)connects.'),
      notice,
    );

    const foot = el('footer', { class: 'sd-foot' },
      resetBtn,
      el('span', { class: 'sd-foot-spacer' }),
      closeBtn,
      saveBtn,
    );

    const card = el('aside', { class: 'chat-settings-drawer-card' }, head, body, foot);
    const backdrop = el('div', {
      class: 'chat-settings-drawer-backdrop',
      onclick: () => this.closeSettingsDrawer(),
    });
    const drawer = el('div', { class: 'chat-settings-drawer' }, backdrop, card);

    this._sdFields = fields;
    this.settingsDrawer = drawer;
    this.root.appendChild(drawer);
  }

  _renderModelDatalist() {
    if (!this._modelDatalist) return;
    this._modelDatalist.replaceChildren();
    for (const m of (this._modelSuggestions || [])) {
      this._modelDatalist.appendChild(el('option', { value: m }));
    }
  }

  _populateSettingsDrawer(agent) {
    if (!this._sdFields) return;
    const s = (agent && agent.settings) || {};
    const f = this._sdFields;
    f.model.value                = typeof s.model === 'string' ? s.model : '';
    f.reasoningEffort.value      = typeof s.reasoningEffort === 'string' ? s.reasoningEffort : '';
    f.systemPromptOverride.value = typeof s.systemPromptOverride === 'string' ? s.systemPromptOverride : '';
    f.rules.value                = typeof s.rules === 'string' ? s.rules : '';
    f.tools.value                = typeof s.tools === 'string' ? s.tools : '';
    f.disallowedTools.value      = typeof s.disallowedTools === 'string' ? s.disallowedTools : '';
    f.allow.value                = Array.isArray(s.allow) ? s.allow.join('\n') : '';
    f.deny.value                 = Array.isArray(s.deny)  ? s.deny.join('\n')  : '';
    f.sandbox.value              = typeof s.sandbox === 'string' ? s.sandbox : '';
    if (typeof s.worktree === 'string' && s.worktree.length) {
      f.worktree.checked = true;
      f.worktreeName.value = s.worktree;
    } else if (s.worktree === true) {
      f.worktree.checked = true;
      f.worktreeName.value = '';
    } else {
      f.worktree.checked = false;
      f.worktreeName.value = '';
    }
    // alwaysApprove defaults to true if not set.
    f.alwaysApprove.checked = !(s.alwaysApprove === false);

    // Live-connected agents need a reconnect before the new settings take
    // effect. Show a small banner explaining that. Mirrors the agent state
    // we track via the sidebar refresh event.
    this._updateSettingsNotice(agent);
  }

  _updateSettingsNotice(agent) {
    if (!this._sdNotice) return;
    const a = agent || this.currentAgent || {};
    const live = !!a.connected && a.status !== 'disconnected' && a.status !== 'exited';
    this._sdNotice.classList.toggle('hidden', !live);
    if (live) {
      this._sdNotice.textContent =
        'Agent is currently connected. Saved changes will apply the NEXT time it (re)connects.';
    } else {
      this._sdNotice.textContent = '';
    }
  }

  _collectSettings() {
    const f = this._sdFields;
    const linesToArr = (s) => String(s || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const out = {
      model:                f.model.value.trim(),
      reasoningEffort:      f.reasoningEffort.value.trim(),
      systemPromptOverride: f.systemPromptOverride.value,
      rules:                f.rules.value,
      tools:                f.tools.value.trim(),
      disallowedTools:      f.disallowedTools.value.trim(),
      allow:                linesToArr(f.allow.value),
      deny:                 linesToArr(f.deny.value),
      sandbox:              f.sandbox.value.trim(),
      alwaysApprove:        !!f.alwaysApprove.checked,
    };
    if (f.worktree.checked) {
      const wn = f.worktreeName.value.trim();
      out.worktree = wn ? wn : true;
    } else {
      out.worktree = null;
    }
    // Drop empty values so the saved payload stays minimal.
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (v == null) { delete out[k]; continue; }
      if (typeof v === 'string' && v.length === 0) { delete out[k]; continue; }
      if (Array.isArray(v) && v.length === 0) { delete out[k]; continue; }
    }
    return out;
  }

  async _submitSettingsDrawer() {
    if (!this.agentId || !this._sdFields) return;
    const settings = this._collectSettings();
    const saveBtn = this.settingsDrawer && this.settingsDrawer.querySelector('.sd-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'saving...';
    }
    try {
      const updated = await api.updateAgent(this.agentId, { settings });
      this.applyAgentRefresh(updated);
      this.showToast('conversation settings saved.', 'info');
      this.closeSettingsDrawer();
    } catch (e) {
      this.showToast(`save failed: ${e && e.message ? e.message : String(e)}`, 'warn');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'save';
      }
    }
  }

  async _clearSettingsDrawer() {
    if (!this.agentId) return;
    try {
      const updated = await api.updateAgent(this.agentId, { settings: null });
      this.applyAgentRefresh(updated);
      this._populateSettingsDrawer(updated || {});
      this.showToast('per-conversation settings cleared.', 'info');
    } catch (e) {
      this.showToast(`clear failed: ${e && e.message ? e.message : String(e)}`, 'warn');
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
