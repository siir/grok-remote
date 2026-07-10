// Pre-create dialog for "+ new" — configure cwd + session settings before spawn.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';

const RECENT_CWD_KEY = 'grok-remote.new-session.recent-cwds';
const RECENT_CWD_MAX = 8;

export interface NewSessionResult {
  name?: string;
  model?: string;
  cwd?: string;
  settings: Record<string, unknown>;
}

interface BrowseEntry {
  name: string;
  path: string;
  type: 'directory';
}

interface BrowseResponse {
  ok?: boolean;
  path?: string;
  parent?: string | null;
  home?: string;
  entries?: BrowseEntry[];
  error?: string;
}

interface AppSettings {
  defaultModel?: string | null;
  defaultCwd?: string | null;
  autoApprove?: boolean;
}

function loadRecentCwds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_CWD_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  } catch {
    return [];
  }
}

export function rememberCwd(cwd: string): void {
  const v = (cwd || '').trim();
  if (!v) return;
  const prev = loadRecentCwds().filter((c) => c !== v);
  const next = [v, ...prev].slice(0, RECENT_CWD_MAX);
  try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

function field(labelText: string, input: HTMLElement, hintText?: string): HTMLElement {
  return el('div', { class: 'sd-field nsd-field' },
    el('label', { class: 'sd-label' }, labelText),
    input,
    hintText ? el('div', { class: 'sd-hint' }, hintText) : null,
  ) as HTMLElement;
}

function linesToArr(s: string): string[] {
  return String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Open the new-session configuration dialog.
 * Resolves with the createAgent body, or null if cancelled.
 */
export function openNewSessionDialog(): Promise<NewSessionResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: NewSessionResult | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    // ── inputs ──────────────────────────────────────────────────────────
    const nameInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'optional — auto-named from first reply',
      autocomplete: 'off',
    }) as HTMLInputElement;

    const cwdInput = el('input', {
      class: 'sd-input nsd-cwd-input',
      type: 'text',
      placeholder: 'leave blank for default sandbox cwd',
      autocomplete: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;

    const browseToggleBtn = el('button', {
      class: 'btn btn--ghost nsd-browse-toggle',
      type: 'button',
      title: 'Browse folders on this machine',
    }, 'browse') as HTMLButtonElement;

    const useHomeBtn = el('button', {
      class: 'btn btn--ghost nsd-cwd-chip',
      type: 'button',
      title: 'Use home directory',
    }, '~') as HTMLButtonElement;

    const cwdRow = el('div', { class: 'nsd-cwd-row' },
      cwdInput,
      useHomeBtn,
      browseToggleBtn,
    ) as HTMLElement;

    const recentHost = el('div', { class: 'nsd-recent' }) as HTMLElement;

    const folderPanel = el('div', {
      class: 'nsd-folder-panel',
      hidden: '',
    }) as HTMLElement;

    const modelInput = el('input', {
      class: 'sd-input',
      type: 'text',
      list: 'nsd-model-list',
      placeholder: 'e.g. grok-code-fast-1',
      autocomplete: 'off',
    }) as HTMLInputElement;

    const reasoningSelect = el('select', { class: 'sd-input' },
      el('option', { value: '' }, 'default'),
      el('option', { value: 'none' }, 'none'),
      el('option', { value: 'minimal' }, 'minimal'),
      el('option', { value: 'low' }, 'low'),
      el('option', { value: 'medium' }, 'medium'),
      el('option', { value: 'high' }, 'high'),
      el('option', { value: 'xhigh' }, 'xhigh'),
    ) as HTMLSelectElement;

    const alwaysApprove = el('input', {
      class: 'sd-checkbox',
      type: 'checkbox',
    }) as HTMLInputElement;
    alwaysApprove.checked = true;

    const systemPromptTa = el('textarea', {
      class: 'sd-input sd-textarea sd-textarea--lg',
      rows: '4',
      placeholder: 'leave blank to keep default.',
    }) as HTMLTextAreaElement;

    const rulesTa = el('textarea', {
      class: 'sd-input sd-textarea sd-textarea--lg',
      rows: '4',
      placeholder: 'one rule per line.',
    }) as HTMLTextAreaElement;

    const toolsInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'read_file,grep,list_dir',
    }) as HTMLInputElement;

    const disallowedInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'web_search,run_terminal_cmd',
    }) as HTMLInputElement;

    const allowTa = el('textarea', {
      class: 'sd-input sd-textarea',
      rows: '3',
      placeholder: 'Bash(npm*)',
    }) as HTMLTextAreaElement;

    const denyTa = el('textarea', {
      class: 'sd-input sd-textarea',
      rows: '3',
      placeholder: 'Bash(rm*)',
    }) as HTMLTextAreaElement;

    const sandboxInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'sandbox profile',
    }) as HTMLInputElement;

    const worktreeInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: '/path/to/existing/worktree  (or a new name to create)',
    }) as HTMLInputElement;

    // Create a real git worktree under ~/.grok/worktrees/<repo>/<name> and
    // run the agent with that as cwd. (grok agent stdio ignores -w.)
    const createWorktreeCb = el('input', {
      class: 'sd-checkbox',
      type: 'checkbox',
    }) as HTMLInputElement;
    const worktreeNameEl = el('code', { class: 'nsd-worktree-name' }, '') as HTMLElement;
    const worktreeRegenBtn = el('button', {
      class: 'btn btn--ghost nsd-worktree-regen',
      type: 'button',
      title: 'Generate another name',
      hidden: '',
    }, '↻') as HTMLButtonElement;
    let autoWorktreeName = randomThreeWordName();
    function paintWorktreeName(): void {
      worktreeNameEl.textContent = createWorktreeCb.checked ? autoWorktreeName : '';
      worktreeRegenBtn.hidden = !createWorktreeCb.checked;
      // Manual path + auto-create are mutually exclusive in the UI.
      worktreeInput.disabled = createWorktreeCb.checked;
      if (createWorktreeCb.checked) worktreeInput.value = '';
    }
    createWorktreeCb.addEventListener('change', paintWorktreeName);
    worktreeRegenBtn.addEventListener('click', () => {
      autoWorktreeName = randomThreeWordName();
      paintWorktreeName();
    });
    const worktreeToggle = el('label', { class: 'sd-toggle nsd-worktree-toggle' },
      createWorktreeCb,
      el('span', { class: 'sd-toggle-text' }, 'create worktree'),
      el('span', { class: 'sd-toggle-hint' },
        'isolated git checkout (requires Folder = a git repo). name: ',
        worktreeNameEl,
        worktreeRegenBtn,
      ),
    ) as HTMLElement;

    // Existing worktrees for the Folder repo (chips). Click → set cwd, clear create.
    const worktreePickerHost = el('div', {
      class: 'nsd-worktree-picker',
      hidden: '',
    }) as HTMLElement;

    interface WtChip {
      path: string;
      branch?: string | null;
      label?: string;
      isMain?: boolean;
    }

    let wtLoadGen = 0;
    async function refreshWorktreePicker(forPath?: string): Promise<void> {
      const gen = ++wtLoadGen;
      const src = (forPath ?? cwdInput.value).trim();
      if (!src || src === '~' || src === '~/') {
        worktreePickerHost.hidden = true;
        worktreePickerHost.replaceChildren();
        return;
      }
      worktreePickerHost.hidden = false;
      worktreePickerHost.replaceChildren(
        el('div', { class: 'nsd-worktree-picker-label' }, 'worktrees'),
        el('span', { class: 'nsd-worktree-picker-status' }, 'loading…'),
      );
      try {
        const res = await api.fs.worktrees(src) as {
          ok?: boolean;
          worktrees?: WtChip[];
          error?: string;
        };
        if (gen !== wtLoadGen) return;
        const list = Array.isArray(res?.worktrees) ? res.worktrees : [];
        // Prefer linked worktrees first; still show main.
        const linked = list.filter((w) => !w.isMain);
        const main = list.filter((w) => w.isMain);
        const ordered = [...linked, ...main];
        if (!ordered.length) {
          worktreePickerHost.replaceChildren(
            el('div', { class: 'nsd-worktree-picker-label' }, 'worktrees'),
            el('span', { class: 'nsd-worktree-picker-status' }, 'none yet — use create worktree'),
          );
          return;
        }
        const current = cwdInput.value.trim();
        worktreePickerHost.replaceChildren(
          el('div', { class: 'nsd-worktree-picker-label' }, 'existing worktrees'),
          ...ordered.map((w) => {
            const label = w.label || (w.branch ? `${pathBase(w.path)} · ${w.branch}` : pathBase(w.path));
            const btn = el('button', {
              class: `nsd-worktree-chip${w.path === current ? ' nsd-worktree-chip--active' : ''}${w.isMain ? ' nsd-worktree-chip--main' : ''}`,
              type: 'button',
              title: w.path,
            }, label) as HTMLButtonElement;
            btn.addEventListener('click', () => {
              // Select existing: set Folder to that checkout; do not create.
              createWorktreeCb.checked = false;
              paintWorktreeName();
              worktreeInput.value = '';
              cwdInput.value = w.path;
              if (browseOpen) void loadBrowse(w.path);
              void refreshWorktreePicker(w.path);
            });
            return btn;
          }),
        );
      } catch (err) {
        if (gen !== wtLoadGen) return;
        const msg = err instanceof Error ? err.message : String(err);
        worktreePickerHost.replaceChildren(
          el('div', { class: 'nsd-worktree-picker-label' }, 'worktrees'),
          el('span', { class: 'nsd-worktree-picker-status nsd-worktree-picker-status--err' }, msg),
        );
      }
    }

    function pathBase(p: string): string {
      const parts = p.replace(/\/+$/, '').split(/[/\\]/);
      return parts[parts.length - 1] || p;
    }

    const modelList = el('datalist', { id: 'nsd-model-list' }) as HTMLDataListElement;
    const errEl = el('div', { class: 'nsd-error', hidden: '' }) as HTMLElement;

    const advancedBody = el('div', { class: 'nsd-advanced-body', hidden: '' },
      el('section', { class: 'sd-section' },
        el('div', { class: 'sd-section-title' }, 'System prompt'),
        field('System prompt override', systemPromptTa,
          'replaces the agent system prompt entirely.'),
        field('Rules', rulesTa, 'extra rules appended to the system prompt.'),
      ),
      el('section', { class: 'sd-section' },
        el('div', { class: 'sd-section-title' }, 'Tools'),
        el('div', { class: 'sd-grid' },
          field('Allowed tools', toolsInput, 'comma-separated allowed tools.'),
          field('Disallowed tools', disallowedInput, 'comma-separated blocked tools.'),
        ),
      ),
      el('section', { class: 'sd-section' },
        el('div', { class: 'sd-section-title' }, 'Permissions'),
        el('div', { class: 'sd-grid' },
          field('Allow', allowTa, 'one rule per line, e.g. Bash(npm*).'),
          field('Deny', denyTa, 'one rule per line; deny wins over allow.'),
        ),
      ),
      el('section', { class: 'sd-section' },
        el('div', { class: 'sd-section-title' }, 'Environment'),
        el('div', { class: 'sd-grid' },
          field('Sandbox profile', sandboxInput, 'sandbox profile name.'),
          field('Worktree path or name', worktreeInput,
            'absolute path → use that checkout as cwd. name → create under ~/.grok/worktrees. ignored when “create worktree” is checked.'),
        ),
      ),
    ) as HTMLElement;

    const advancedToggle = el('button', {
      class: 'nsd-advanced-toggle',
      type: 'button',
      'aria-expanded': 'false',
    }, '▸ Advanced settings') as HTMLButtonElement;

    advancedToggle.addEventListener('click', () => {
      const open = advancedBody.hidden;
      advancedBody.hidden = !open;
      advancedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      advancedToggle.textContent = open ? '▾ Advanced settings' : '▸ Advanced settings';
    });

    // ── folder browser ──────────────────────────────────────────────────
    let browsePath = '';
    let browseParent: string | null = null;
    let homePath = '';
    let browseOpen = false;

    const folderPathLabel = el('div', { class: 'nsd-folder-path' }, '') as HTMLElement;
    const folderList = el('div', { class: 'nsd-folder-list' }) as HTMLElement;
    const folderStatus = el('div', { class: 'nsd-folder-status' }, '') as HTMLElement;
    const folderUpBtn = el('button', {
      class: 'btn btn--ghost nsd-folder-nav',
      type: 'button',
    }, '↑ parent') as HTMLButtonElement;
    const folderHomeBtn = el('button', {
      class: 'btn btn--ghost nsd-folder-nav',
      type: 'button',
    }, 'home') as HTMLButtonElement;
    const folderUseBtn = el('button', {
      class: 'btn btn--primary nsd-folder-use',
      type: 'button',
    }, 'use this folder') as HTMLButtonElement;

    folderPanel.append(
      el('div', { class: 'nsd-folder-toolbar' },
        folderUpBtn,
        folderHomeBtn,
        el('span', { class: 'nsd-folder-toolbar-spacer' }),
        folderUseBtn,
      ) as HTMLElement,
      folderPathLabel,
      folderList,
      folderStatus,
    );

    async function loadBrowse(target?: string): Promise<void> {
      folderStatus.textContent = 'loading…';
      folderList.replaceChildren(el('div', { class: 'nsd-folder-empty' }, 'loading…'));
      try {
        const data = await api.fs.browse(target ?? (browsePath || null)) as BrowseResponse;
        browsePath = data.path || '';
        browseParent = data.parent ?? null;
        if (data.home) homePath = data.home;
        folderPathLabel.textContent = browsePath || '·';
        folderPathLabel.title = browsePath || '';
        folderUpBtn.disabled = !browseParent;

        if (data.error) {
          folderStatus.textContent = data.error;
          folderList.replaceChildren(
            el('div', { class: 'nsd-folder-empty nsd-folder-empty--err' }, data.error),
          );
          return;
        }
        const entries = Array.isArray(data.entries) ? data.entries : [];
        folderStatus.textContent = entries.length
          ? `${entries.length} folder${entries.length === 1 ? '' : 's'}`
          : 'no subfolders';
        if (!entries.length) {
          folderList.replaceChildren(
            el('div', { class: 'nsd-folder-empty' }, 'no subfolders here'),
          );
          return;
        }
        folderList.replaceChildren(...entries.map((ent) => {
          const btn = el('button', {
            class: 'nsd-folder-item',
            type: 'button',
            title: ent.path,
          },
            el('span', { class: 'nsd-folder-item-ico' }, '📁'),
            el('span', { class: 'nsd-folder-item-name' }, ent.name),
          ) as HTMLButtonElement;
          btn.addEventListener('click', () => {
            cwdInput.value = ent.path;
            void loadBrowse(ent.path);
            void refreshWorktreePicker(ent.path);
          });
          return btn;
        }));
        void refreshWorktreePicker(browsePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        folderStatus.textContent = msg;
        folderList.replaceChildren(
          el('div', { class: 'nsd-folder-empty nsd-folder-empty--err' }, msg),
        );
      }
    }

    function setBrowseOpen(open: boolean): void {
      browseOpen = open;
      folderPanel.hidden = !open;
      browseToggleBtn.textContent = open ? 'hide' : 'browse';
      browseToggleBtn.classList.toggle('nsd-browse-toggle--on', open);
      if (open) {
        void loadBrowse(cwdInput.value.trim() || undefined);
      }
    }

    browseToggleBtn.addEventListener('click', () => setBrowseOpen(!browseOpen));
    folderUpBtn.addEventListener('click', () => {
      if (browseParent) {
        cwdInput.value = browseParent;
        void loadBrowse(browseParent);
      }
    });
    folderHomeBtn.addEventListener('click', () => {
      const h = homePath || '';
      if (h) cwdInput.value = h;
      void loadBrowse(h || undefined);
    });
    folderUseBtn.addEventListener('click', () => {
      if (browsePath) cwdInput.value = browsePath;
      setBrowseOpen(false);
      cwdInput.focus();
      void refreshWorktreePicker(cwdInput.value);
    });
    useHomeBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const data = await api.fs.browse(null) as BrowseResponse;
          if (data.home) {
            cwdInput.value = data.home;
            homePath = data.home;
            if (browseOpen) void loadBrowse(data.home);
            void refreshWorktreePicker(data.home);
          }
        } catch { /* ignore */ }
      })();
    });
    cwdInput.addEventListener('change', () => { void refreshWorktreePicker(); });
    cwdInput.addEventListener('blur', () => { void refreshWorktreePicker(); });

    // ── recent cwds ─────────────────────────────────────────────────────
    function paintRecent(extra: string[] = []): void {
      const seen = new Set<string>();
      const items: string[] = [];
      for (const c of [...extra, ...loadRecentCwds()]) {
        const t = (c || '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        items.push(t);
        if (items.length >= RECENT_CWD_MAX) break;
      }
      if (!items.length) {
        recentHost.replaceChildren();
        recentHost.hidden = true;
        return;
      }
      recentHost.hidden = false;
      recentHost.replaceChildren(
        el('div', { class: 'nsd-recent-label' }, 'recent'),
        ...items.map((c) => {
          const btn = el('button', {
            class: 'nsd-recent-chip',
            type: 'button',
            title: c,
          }, shortenPath(c)) as HTMLButtonElement;
          btn.addEventListener('click', () => {
            cwdInput.value = c;
            if (browseOpen) void loadBrowse(c);
            void refreshWorktreePicker(c);
          });
          return btn;
        }),
      );
    }

    // ── collect / submit ────────────────────────────────────────────────
    function collect(): NewSessionResult {
      const settings: Record<string, unknown> = {
        alwaysApprove: !!alwaysApprove.checked,
      };
      const model = modelInput.value.trim();
      if (model) settings.model = model;
      const re = reasoningSelect.value.trim();
      if (re) settings.reasoningEffort = re;
      const sp = systemPromptTa.value;
      if (sp.trim()) settings.systemPromptOverride = sp;
      const rules = rulesTa.value;
      if (rules.trim()) settings.rules = rules;
      const tools = toolsInput.value.trim();
      if (tools) settings.tools = tools;
      const dis = disallowedInput.value.trim();
      if (dis) settings.disallowedTools = dis;
      const allow = linesToArr(allowTa.value);
      if (allow.length) settings.allow = allow;
      const deny = linesToArr(denyTa.value);
      if (deny.length) settings.deny = deny;
      const sandbox = sandboxInput.value.trim();
      if (sandbox) settings.sandbox = sandbox;
      if (createWorktreeCb.checked) {
        settings.worktree = autoWorktreeName || randomThreeWordName();
      } else {
        const wt = worktreeInput.value.trim();
        if (wt) settings.worktree = wt;
      }

      const out: NewSessionResult = { settings };
      const name = nameInput.value.trim();
      if (name) out.name = name;
      if (model) out.model = model;
      const cwd = cwdInput.value.trim();
      if (cwd) out.cwd = cwd;
      return out;
    }

    const createBtn = el('button', {
      class: 'btn btn--primary',
      type: 'button',
    }, 'create session') as HTMLButtonElement;
    const cancelBtn = el('button', {
      class: 'btn btn--ghost',
      type: 'button',
    }, 'cancel') as HTMLButtonElement;

    function isVagueHomeCwd(p: string | undefined): boolean {
      const t = (p || '').trim();
      return !t || t === '~' || t === '~/' || t === '~/.' ;
    }

    createBtn.addEventListener('click', () => {
      errEl.hidden = true;
      const body = collect();
      // Creating a worktree needs a real git repo as the source Folder.
      // `~/` alone is never a useful git root (siir/grok-remote#10).
      if (body.settings?.worktree && isVagueHomeCwd(body.cwd)) {
        errEl.textContent = 'set Folder to a git repository before creating a worktree (not ~/ alone)';
        errEl.hidden = false;
        return;
      }
      // Don't send bare ~ as cwd (server would treat it as a relative path).
      if (isVagueHomeCwd(body.cwd)) delete body.cwd;
      // Don't persist bare ~ as a "recent" path.
      if (body.cwd) rememberCwd(body.cwd);
      finish(body);
    });
    cancelBtn.addEventListener('click', () => finish(null));

    // ── layout ──────────────────────────────────────────────────────────
    const section = (title: string, ...children: HTMLElement[]) =>
      el('section', { class: 'sd-section' },
        el('div', { class: 'sd-section-title' }, title),
        ...children,
      ) as HTMLElement;

    const body = el('div', { class: 'nsd-body sd-body' },
      section('Working directory',
        field('Folder', cwdRow as unknown as HTMLElement,
          'Where the agent runs. Blank uses Settings → default cwd, or a private sandbox. Prefer a separate worktree when editing grok-remote itself.'),
        worktreeToggle,
        worktreePickerHost,
        recentHost,
        folderPanel,
      ),
      section('Identity',
        field('Name', nameInput, 'optional; auto-named from the first reply if blank.'),
      ),
      section('Model',
        el('div', { class: 'sd-grid' },
          field('Model', modelInput, 'overrides the global default. blank = use default.'),
          field('Reasoning effort', reasoningSelect, 'none | minimal | low | medium | high | xhigh.'),
        ) as HTMLElement,
        el('label', { class: 'sd-toggle' },
          alwaysApprove,
          el('span', { class: 'sd-toggle-text' }, 'always approve tool calls'),
          el('span', { class: 'sd-toggle-hint' }, 'auto-approve every tool call (default on).'),
        ) as HTMLElement,
      ),
      advancedToggle,
      advancedBody,
      modelList,
      errEl,
    ) as HTMLElement;

    const head = el('header', { class: 'sd-head nsd-head' },
      el('h3', { class: 'sd-title' }, 'New session'),
      el('div', { class: 'sd-sub' },
        'Configure the working folder and grok flags before the agent starts.'),
    ) as HTMLElement;

    const foot = el('footer', { class: 'sd-foot nsd-foot' },
      el('span', { class: 'sd-foot-spacer' }),
      cancelBtn,
      createBtn,
    ) as HTMLElement;

    const card = el('div', {
      class: 'nsd-card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'New session',
    }, head, body, foot) as HTMLElement;

    const backdrop = el('div', { class: 'nsd-backdrop' }) as HTMLElement;
    const root = el('div', { class: 'nsd-modal' }, backdrop, card) as HTMLElement;

    backdrop.addEventListener('click', () => finish(null));

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(null);
      }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        createBtn.click();
      }
    };
    document.addEventListener('keydown', onKey);

    function cleanup(): void {
      document.removeEventListener('keydown', onKey);
      try { root.remove(); } catch { /* ignore */ }
    }

    document.body.appendChild(root);
    // Prefill from settings + recent.
    void (async () => {
      let defaults: AppSettings = {};
      try {
        defaults = await api.getSettings() as AppSettings;
      } catch { /* ignore */ }

      // Prefer a remembered project path over bare ~/ so create-worktree
      // has a plausible git root. Leave blank if all we have is home.
      const isVagueHome = (p: string | undefined | null): boolean => {
        const t = (p || '').trim();
        return !t || t === '~' || t === '~/' || t === '~/.' ;
      };
      const recent = loadRecentCwds();
      const preferred =
        recent.find((c) => !isVagueHome(c)) ||
        (!isVagueHome(defaults.defaultCwd) ? String(defaults.defaultCwd) : '') ||
        '';
      if (preferred) cwdInput.value = preferred;
      else cwdInput.value = '';
      cwdInput.placeholder = preferred
        ? 'leave blank for default sandbox cwd'
        : 'pick a git repo (browse) — needed for create worktree';

      if (defaults.defaultModel) modelInput.value = defaults.defaultModel;
      if (typeof defaults.autoApprove === 'boolean') {
        alwaysApprove.checked = defaults.autoApprove;
      }
      paintRecent(
        [preferred, defaults.defaultCwd || '', ...recent].filter(Boolean) as string[],
      );
      void refreshWorktreePicker(cwdInput.value);

      try {
        const models = await api.systemModels.get() as { items?: Array<{ id?: string }> };
        const items = Array.isArray(models?.items) ? models.items : [];
        modelList.replaceChildren(
          ...items
            .map((i) => (i && typeof i.id === 'string' ? i.id : ''))
            .filter(Boolean)
            .map((id) => el('option', { value: id })),
        );
      } catch { /* leave empty */ }

      cwdInput.focus();
      if (cwdInput.value) cwdInput.select();
    })();
  });
}

function shortenPath(p: string, max = 42): string {
  if (p.length <= max) return p;
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return `…${p.slice(-(max - 1))}`;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Short adjective-noun-noun slug for `grok -w <name>`. */
const WT_WORDS = [
  'amber', 'brisk', 'coral', 'delta', 'ember', 'flint', 'grove', 'haven',
  'ivory', 'jade', 'keen', 'lunar', 'mist', 'nova', 'olive', 'pine',
  'quartz', 'river', 'sage', 'tide', 'umbra', 'violet', 'willow', 'zephyr',
  'anchor', 'beacon', 'cinder', 'drift', 'echo', 'forge', 'glimmer', 'harbor',
];

export function randomThreeWordName(): string {
  const pick = (): string => WT_WORDS[Math.floor(Math.random() * WT_WORDS.length)] || 'nova';
  return `${pick()}-${pick()}-${pick()}`;
}
