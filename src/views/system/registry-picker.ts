// Generic "Browse registry" modal used by the MCP and LSP settings pages.

export interface RegistryPickEntry {
  slug: string;
  name: string;
  description: string;
  group: string;
  tags?: string[];
  official?: boolean;
  envHints?: string[];
  docsUrl?: string;
}

export interface OpenRegistryPickerOptions {
  title: string;
  groupLabel: string;
  entries: RegistryPickEntry[];
  groupOrder?: string[];
  onAdd: (slug: string) => void;
  closeAfterAdd?: boolean;
}

export function openRegistryPicker(opts: OpenRegistryPickerOptions): () => void {
  const root = document.createElement('div');
  root.className = 'registry-picker';

  const backdrop = document.createElement('div');
  backdrop.className = 'registry-picker__backdrop';
  root.appendChild(backdrop);

  const card = document.createElement('div');
  card.className = 'registry-picker__card';
  root.appendChild(card);

  const head = document.createElement('header');
  head.className = 'registry-picker__head';
  const h2 = document.createElement('h2');
  h2.textContent = opts.title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mcp-btn';
  closeBtn.textContent = 'close';
  head.appendChild(h2);
  head.appendChild(closeBtn);
  card.appendChild(head);

  const filterRow = document.createElement('div');
  filterRow.className = 'registry-picker__filter';
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.placeholder = 'filter...';
  filter.autocomplete = 'off';
  filterRow.appendChild(filter);
  card.appendChild(filterRow);

  const body = document.createElement('div');
  body.className = 'registry-picker__body';
  card.appendChild(body);

  function close(): void {
    document.removeEventListener('keydown', onKey);
    if (root.parentNode) root.parentNode.removeChild(root);
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  }
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  function paint(query: string): void {
    body.replaceChildren();
    const q = query.trim().toLowerCase();
    const filtered = opts.entries.filter(e => {
      if (!q) return true;
      const hay = `${e.name} ${e.slug} ${e.description} ${e.group} ${(e.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'registry-picker__empty';
      empty.textContent = 'nothing matches that filter.';
      body.appendChild(empty);
      return;
    }
    const groups = new Map<string, RegistryPickEntry[]>();
    for (const e of filtered) {
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group)!.push(e);
    }
    const order = (opts.groupOrder && opts.groupOrder.length)
      ? opts.groupOrder.filter(g => groups.has(g)).concat(Array.from(groups.keys()).filter(g => !opts.groupOrder!.includes(g)))
      : Array.from(groups.keys());
    for (const g of order) {
      const items = groups.get(g);
      if (!items || !items.length) continue;
      const section = document.createElement('section');
      section.className = 'registry-picker__group';
      const heading = document.createElement('h3');
      heading.className = 'registry-picker__group-title';
      heading.textContent = `${opts.groupLabel}: ${g}`;
      section.appendChild(heading);
      for (const e of items) section.appendChild(renderItem(e));
      body.appendChild(section);
    }
  }

  function renderItem(e: RegistryPickEntry): HTMLElement {
    const item = document.createElement('article');
    item.className = 'registry-item';

    const itemHead = document.createElement('div');
    itemHead.className = 'registry-item__head';
    const title = document.createElement('span');
    title.className = 'registry-item__title';
    title.textContent = e.name;
    itemHead.appendChild(title);
    if (e.official) {
      const badge = document.createElement('span');
      badge.className = 'registry-item__badge';
      badge.textContent = 'official';
      itemHead.appendChild(badge);
    }
    if (Array.isArray(e.tags)) {
      for (const tag of e.tags) {
        const t = document.createElement('span');
        t.className = 'registry-item__tag';
        t.textContent = tag;
        itemHead.appendChild(t);
      }
    }
    item.appendChild(itemHead);

    const desc = document.createElement('p');
    desc.className = 'registry-item__desc';
    desc.textContent = e.description;
    item.appendChild(desc);

    if (Array.isArray(e.envHints) && e.envHints.length) {
      const envList = document.createElement('ul');
      envList.className = 'registry-item__env-list';
      for (const h of e.envHints) {
        const li = document.createElement('li');
        li.textContent = h;
        envList.appendChild(li);
      }
      item.appendChild(envList);
    }

    const actions = document.createElement('div');
    actions.className = 'registry-item__actions';
    if (e.docsUrl) {
      const a = document.createElement('a');
      a.href = e.docsUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'registry-item__docs';
      a.textContent = 'docs';
      actions.appendChild(a);
    }
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'mcp-btn mcp-btn--primary';
    addBtn.textContent = 'add';
    addBtn.addEventListener('click', () => {
      opts.onAdd(e.slug);
      if (opts.closeAfterAdd) close();
    });
    actions.appendChild(addBtn);
    item.appendChild(actions);

    return item;
  }

  filter.addEventListener('input', () => paint(filter.value));
  paint('');

  document.body.appendChild(root);
  queueMicrotask(() => filter.focus());
  return close;
}
