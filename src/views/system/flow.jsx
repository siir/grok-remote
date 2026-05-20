// Live agent flow page.
//
// Renders one node per agent on a React Flow canvas. For each agent we open
// an SSE stream and translate the events into:
//   - node status        ("idle" / "running" / "errored" / "disconnected")
//   - token totals       (from event _meta.totalTokens when present)
//   - tool-call satellite nodes (grouped when same-kind in close succession)
//   - background-task nodes (one per live grok bg shell, polled from
//                            /api/agents/:id/terminals)
//   - workflow milestones (turn boundaries, bg start/stop, dev-server URL)
//
// Click an agent node to jump to that agent's conversation. Toolbar exposes
// refresh (re-poll the list now), fit-view, a toggle to include archived
// agents, and a stats panel toggle.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { api } from '../../lib/api.js';
import { fmtTokens } from '../../lib/format.js';

// How often we re-poll the agent list. SSE keeps individual cards live; this
// is only here to pick up newly-spawned or deleted agents.
const LIST_POLL_MS = 5000;
// How often we re-poll the per-agent bg terminal list. The SSE stream gives
// us start/stop events, but the URL detection + output sniffing lives on
// the REST endpoint, so we poll while the view is open.
const BG_TERMINALS_POLL_MS = 2000;
// Cap milestones we keep around. Older ones rotate out of the strip.
const MILESTONE_CAP = 40;
// Group same-kind tool calls that started within this many ms of the
// previous call's end (or start, if it has no end yet).
const GROUP_GAP_MS = 3000;

const STATUS_RANK = {
  running: 0, idle: 1, errored: 2, disconnected: 3, exited: 3, killed: 3, unknown: 4,
};

function normaliseStatus(s) {
  if (!s) return 'unknown';
  if (s === 'exited' || s === 'killed') return 'disconnected';
  return s;
}

// ── custom node renderers ─────────────────────────────────────────────────

function AgentNode({ data }) {
  const status = normaliseStatus(data.status);
  const hist = Array.isArray(data.tokensHistory) ? data.tokensHistory : [];
  const sparkPath = (hist.length >= 2) ? buildSparkPath(hist, 120, 16) : null;
  return (
    <div className={`flow-agent-node flow-agent-node--${status}`}>
      <Handle type="source" position={Position.Right} className="flow-handle" />
      <Handle type="target" position={Position.Right} className="flow-handle" />
      <Handle type="source" id="bg" position={Position.Bottom} className="flow-handle" />
      <div className="flow-agent-node__row">
        <span className={`flow-agent-node__dot flow-agent-node__dot--${status}`} />
        <span className="flow-agent-node__name" title={data.name}>{data.name}</span>
      </div>
      <div className="flow-agent-node__row flow-agent-node__row--meta">
        <span className="flow-agent-node__model" title={data.model}>{data.model || 'no model'}</span>
        <span className={`flow-agent-node__pill flow-agent-node__pill--${status}`}>{status}</span>
      </div>
      <div className="flow-agent-node__row flow-agent-node__row--meta">
        <span className="flow-agent-node__tokens">
          {data.tokens ? `${formatTokens(data.tokens)} tok` : '0 tok'}
        </span>
        {data.inFlight > 0 ? (
          <span className="flow-agent-node__inflight">{data.inFlight} tool{data.inFlight === 1 ? '' : 's'}</span>
        ) : null}
      </div>
      {sparkPath && (
        <svg
          className="flow-agent-node__spark"
          viewBox="0 0 120 16"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={sparkPath.area} fill="rgba(94, 234, 212, 0.15)" />
          <path d={sparkPath.line} fill="none" stroke="var(--teal)" strokeWidth="1.2" />
        </svg>
      )}
    </div>
  );
}

function buildSparkPath(history, W, H) {
  const n = history.length;
  const vMin = Math.min(...history.map(p => p.v));
  const vMax = Math.max(...history.map(p => p.v));
  const range = Math.max(1, vMax - vMin);
  const xs = (i) => (n === 1 ? 0 : (i / (n - 1)) * W);
  const ys = (v) => H - 1 - ((v - vMin) / range) * (H - 2);
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = xs(i).toFixed(2);
    const y = ys(history[i].v).toFixed(2);
    d += (i === 0 ? 'M' : 'L') + ' ' + x + ' ' + y + ' ';
  }
  const area = d + ` L ${W} ${H} L 0 ${H} Z`;
  return { line: d.trim(), area };
}

function ToolNode({ data }) {
  const status = (data.status || 'pending').toLowerCase();
  const [open, setOpen] = useState(false);
  const dur = (data.endedAt && data.startedAt) ? (data.endedAt - data.startedAt) : null;
  const liveDur = (!data.endedAt && data.startedAt) ? (Date.now() - data.startedAt) : null;
  const showDur = dur != null ? fmtDuration(dur) : (liveDur != null ? `${fmtDuration(liveDur)}...` : '');
  const outputText = Array.isArray(data.content) ? data.content.map(c => c.text).join('\n').trim() : '';
  const hasOutput = !!outputText;
  const hasInput  = data.rawInput && Object.keys(data.rawInput).length > 0;

  return (
    <div className={`flow-tool-node flow-tool-node--${status} ${open ? 'flow-tool-node--open' : ''}`}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <Handle type="source" position={Position.Left} className="flow-handle" />
      <button
        type="button"
        className="flow-tool-node__head"
        onClick={() => setOpen((v) => !v)}
        title={data.label}
      >
        <span className="flow-tool-node__kind">{data.kind || 'tool'}</span>
        <span className="flow-tool-node__label">{data.label || ''}</span>
        <span className="flow-tool-node__meta">
          {showDur && <span className="flow-tool-node__dur">{showDur}</span>}
          <span className={`flow-tool-node__status flow-tool-node__status--${status}`}>{data.status || 'pending'}</span>
        </span>
      </button>
      {open && (
        <div className="flow-tool-node__body">
          {Array.isArray(data.locations) && data.locations.length > 0 && (
            <div className="flow-tool-node__section">
              <div className="flow-tool-node__section-title">locations</div>
              <ul className="flow-tool-node__locs">
                {data.locations.map((l, i) => (
                  <li key={i}>{(l && (l.path || l.uri || l.file)) || JSON.stringify(l)}</li>
                ))}
              </ul>
            </div>
          )}
          {hasInput && (
            <div className="flow-tool-node__section">
              <div className="flow-tool-node__section-title">input</div>
              <pre className="flow-tool-node__pre">{safeStringify(data.rawInput)}</pre>
            </div>
          )}
          {hasOutput && (
            <div className="flow-tool-node__section">
              <div className="flow-tool-node__section-title">output</div>
              <pre className="flow-tool-node__pre">{outputText}</pre>
            </div>
          )}
          {data.rawOutput != null && (
            <div className="flow-tool-node__section">
              <div className="flow-tool-node__section-title">rawOutput</div>
              <pre className="flow-tool-node__pre">{safeStringify(data.rawOutput)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Collapsed N-of-a-kind summary. Clicking toggles expansion; expansion
// itself is owned by the parent FlowInner because nodes need to be added
// and re-laid-out, not just visibility-toggled inside the node.
function GroupNode({ data }) {
  const totalMs = data.totalMs || 0;
  const avgMs   = data.count ? Math.round(totalMs / data.count) : 0;
  const hasFailed = data.failedCount > 0;
  return (
    <div
      className={`flow-group-node${data.expanded ? ' flow-group-node--open' : ''}${hasFailed ? ' flow-group-node--has-fail' : ''}`}
      onClick={() => { if (data.onToggle) data.onToggle(); }}
      title={`${data.count} ${data.kind} calls. click to ${data.expanded ? 'collapse' : 'expand'}`}
    >
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <Handle type="source" position={Position.Left} className="flow-handle" />
      <div className="flow-group-node__head">
        <span className="flow-group-node__kind">{(data.kind || 'tool').toUpperCase()}</span>
        <span className="flow-group-node__times">x {data.count}</span>
        <span className="flow-group-node__chev">{data.expanded ? 'v' : '>'}</span>
      </div>
      <div className="flow-group-node__sub">
        {fmtDuration(totalMs)} total{avgMs ? `, avg ${fmtDuration(avgMs)}` : ''}
        {hasFailed ? ` . ${data.failedCount} failed` : ''}
      </div>
    </div>
  );
}

// Long-running shell launched via grok task_backgrounded. One node per
// active bg task, stacked below the agent node. Pulsing amber dot, command
// preview, optional dev-server URL, and exit status when completed.
function BgTaskNode({ data }) {
  const exited = !!data.exited;
  const elapsed = data.startedAt
    ? (exited && data.endedAt ? data.endedAt - data.startedAt : Date.now() - data.startedAt)
    : 0;
  const cmdShort = (data.command || '').length > 64
    ? (data.command || '').slice(0, 61) + '...'
    : (data.command || '(no command)');
  const code = data.exitStatus && (data.exitStatus.exitCode != null ? data.exitStatus.exitCode : data.exitStatus.signal);
  return (
    <div className={`flow-bg-node${exited ? ' flow-bg-node--exited' : ''}`}>
      <Handle type="target" id="bg" position={Position.Top} className="flow-handle" />
      <div className="flow-bg-node__head">
        <span className={`flow-bg-node__dot${exited ? ' flow-bg-node__dot--exited' : ''}`} />
        <span className="flow-bg-node__kind">{exited ? 'bg done' : 'bg shell'}</span>
        <span className="flow-bg-node__elapsed" title={`started ${new Date(data.startedAt || 0).toLocaleTimeString()}`}>
          {elapsed > 0 ? fmtDuration(elapsed) : ''}
        </span>
      </div>
      <div className="flow-bg-node__cmd" title={data.command || ''}>{cmdShort}</div>
      <div className="flow-bg-node__meta">
        {data.url ? (
          <a
            className="flow-bg-node__url"
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`open ${data.url}`}
          >open {data.url.replace(/^https?:\/\//, '')}</a>
        ) : (exited ? (
          <span className="flow-bg-node__exit">
            exit {code != null ? code : '?'}
          </span>
        ) : (
          <span className="flow-bg-node__pending">no URL yet</span>
        ))}
      </div>
    </div>
  );
}

// Horizontal milestone strip lives at the top of the canvas. One node per
// significant event (turn boundary, bg start/stop, URL bound). The strip is
// laid out left-to-right by timestamp.
function MilestoneNode({ data }) {
  const ts = data.t ? new Date(data.t).toLocaleTimeString([], { hour12: false }) : '';
  return (
    <div className={`flow-milestone-node flow-milestone-node--${data.kind}`} title={`${data.label}\n${ts}`}>
      <div className="flow-milestone-node__icon">{data.icon || 'o'}</div>
      <div className="flow-milestone-node__label">{data.label}</div>
      <div className="flow-milestone-node__time">{ts}</div>
      <div className="flow-milestone-node__tail" />
    </div>
  );
}

function safeStringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

const NODE_TYPES = {
  agent: AgentNode,
  tool: ToolNode,
  group: GroupNode,
  bgTask: BgTaskNode,
  milestone: MilestoneNode,
};

// ── helpers ───────────────────────────────────────────────────────────────

function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Lay agent cards out in a column on the left, leaving the right half of the
// canvas for tool-call satellites. React Flow handles panning + zoom.
// ROW_PER_AGENT leaves room for the bg-task stack that hangs below each
// agent (we cap visible bg nodes per agent to BG_NODES_VISIBLE).
const AGENT_ROW_HEIGHT     = 320;
const AGENT_TOP_OFFSET     = 110; // leave the milestone strip uncluttered
const BG_NODE_VERTICAL_GAP = 78;
const BG_NODES_VISIBLE     = 3;

function layoutAgents(agents) {
  return agents.map((a, i) => ({
    id: `agent:${a.id}`,
    type: 'agent',
    position: { x: 0, y: AGENT_TOP_OFFSET + i * AGENT_ROW_HEIGHT },
    draggable: true,
    data: {
      agentId: a.id,
      name:    a.name || a.id.slice(0, 8),
      model:   a.model || '',
      status:  a.status || 'idle',
      tokens:  0,
      inFlight: 0,
    },
  }));
}

// Walk tool calls in chronological order and fold adjacent same-kind
// runs into groups. A run is two-or-more consecutive calls of identical
// `kind` where the gap between (prev.endedAt || prev.startedAt) and
// next.startedAt is under GROUP_GAP_MS. Single calls stay as individual
// tool entries.
function groupToolCalls(sortedCalls) {
  const out = [];
  let i = 0;
  while (i < sortedCalls.length) {
    const start = sortedCalls[i];
    const kind = start.kind || 'tool';
    let j = i + 1;
    while (j < sortedCalls.length) {
      const prev = sortedCalls[j - 1];
      const next = sortedCalls[j];
      if ((next.kind || 'tool') !== kind) break;
      const prevEnd = prev.endedAt || prev.startedAt || 0;
      const nextStart = next.startedAt || 0;
      if (nextStart - prevEnd > GROUP_GAP_MS) break;
      j++;
    }
    const runLen = j - i;
    if (runLen >= 3) {
      const items = sortedCalls.slice(i, j);
      const totalMs = items.reduce((acc, c) => {
        const e = c.endedAt || (c.startedAt ? Date.now() : 0);
        const s = c.startedAt || 0;
        return acc + Math.max(0, e - s);
      }, 0);
      const failedCount = items.filter(c => String(c.status || '').toLowerCase() === 'failed').length;
      out.push({
        type: 'group',
        kind,
        count: runLen,
        startedAt: items[0].startedAt || 0,
        endedAt: items[items.length - 1].endedAt || null,
        totalMs,
        failedCount,
        items,
      });
    } else {
      for (let k = i; k < j; k++) out.push({ type: 'call', call: sortedCalls[k] });
    }
    i = j;
  }
  return out;
}

// ── main app ──────────────────────────────────────────────────────────────

// `filterIds` (optional) limits the canvas to a fixed set of agent ids.
// When set we also drop the "show archived" toggle and the polling-driven
// list mutation: the canvas is scoped to exactly that conversation.
function FlowInner({ filterIds = null }) {
  const hasFilter = Array.isArray(filterIds) && filterIds.length > 0;
  const [showAll, setShowAll] = useState(false);
  const scoped = hasFilter && !showAll;

  const [agents, setAgents]               = useState([]);
  const [showArchived, setShowArchived]   = useState(false);
  const [agentState, setAgentState]       = useState({}); // id -> { status, tokens, inFlight, calls, bgTerminals, milestones, turn }
  const [expandedGroups, setExpandedGroups] = useState({}); // `${agentId}:${groupKey}` -> bool
  const [statsOpen, setStatsOpen]         = useState(hasFilter); // open by default in scoped view
  const [tick, setTick]                   = useState(0); // forces re-render of live durations
  const { fitView } = useReactFlow();

  // Mutable refs that survive re-renders without re-subscribing effects.
  const streamsRef    = useRef(new Map()); // id -> EventSource
  const pollTimerRef  = useRef(null);
  const bgPollTimerRef = useRef(null);

  // Keep latest values reachable inside polling closures without retriggering.
  const showArchivedRef = useRef(showArchived);
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);
  const filterIdsRef = useRef(filterIds);
  useEffect(() => { filterIdsRef.current = filterIds; }, [filterIds]);
  const showAllRef = useRef(showAll);
  useEffect(() => { showAllRef.current = showAll; }, [showAll]);
  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  // ── pure helpers that mutate state immutably ───────────────────────────

  const patchAgent = useCallback((id, patch) => {
    setAgentState((prev) => {
      // Hydrate tokensHistory from sessionStorage on first touch so the
      // sparkline survives page reloads + view remounts.
      let cur = prev[id];
      if (!cur) {
        const persisted = loadTokenHistory(id);
        const lastTok = persisted.length ? persisted[persisted.length - 1].v : 0;
        cur = {
          status: 'idle',
          tokens: lastTok,
          inFlight: 0,
          peakInFlight: 0,
          calls: {},
          tokensHistory: persisted,
          bgTerminals: [],
          milestones: [],
          turn: 0,
          lastActivityAt: 0,
          lastUserAt: 0,
        };
      }
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      // Persist when history grew. Cheap; runs at most ~2/sec per agent.
      if (next.tokensHistory && next.tokensHistory !== cur.tokensHistory) {
        saveTokenHistory(id, next.tokensHistory);
      }
      return { ...prev, [id]: next };
    });
  }, []);

  const pushMilestone = useCallback((id, m) => {
    patchAgent(id, (cur) => {
      const ms = cur.milestones ? cur.milestones.slice() : [];
      // Dedup adjacent identical milestones (same kind + label within 1s).
      const last = ms[ms.length - 1];
      if (last && last.kind === m.kind && last.label === m.label && (m.t - last.t) < 1000) {
        return cur;
      }
      ms.push(m);
      if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
      return { ...cur, milestones: ms, lastActivityAt: m.t };
    });
  }, [patchAgent]);

  // ── SSE wiring ─────────────────────────────────────────────────────────

  const openStreamFor = useCallback((agent) => {
    if (streamsRef.current.has(agent.id)) return;
    const url = `/api/agents/${encodeURIComponent(agent.id)}/stream`;
    let es;
    try {
      es = new EventSource(url);
    } catch {
      return;
    }
    streamsRef.current.set(agent.id, es);

    const safeParse = (raw) => {
      try { return JSON.parse(raw); } catch { return null; }
    };

    const bumpTokens = (data) => {
      const t = data && data._meta && Number(data._meta.totalTokens);
      if (Number.isFinite(t) && t > 0) {
        patchAgent(agent.id, (cur) => {
          if (t <= cur.tokens) return cur; // monotone; skip duplicates
          const hist = Array.isArray(cur.tokensHistory) ? cur.tokensHistory.slice() : [];
          hist.push({ t: Date.now(), v: t });
          // Cap to 60 samples to keep memory bounded but give the bigger
          // stats chart something to chew on.
          if (hist.length > 60) hist.splice(0, hist.length - 60);
          return { ...cur, tokens: t, tokensHistory: hist, lastActivityAt: Date.now() };
        });
      }
    };

    es.addEventListener('agent_status', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      const status = normaliseStatus(data.status || data.state);
      patchAgent(agent.id, (cur) => ({ ...cur, status, lastActivityAt: Date.now() }));
    });

    es.addEventListener('tool_call', (ev) => {
      const raw = safeParse(ev.data);
      if (!raw) return;
      bumpTokens(raw);
      // The wire payload from the agent stream is wrapped: { update, _meta, sessionId, _t }.
      // The actual ACP tool_call object lives in update; some history paths
      // serve it flat, so accept either.
      const u = (raw.update && typeof raw.update === 'object') ? raw.update : raw;
      const id     = u.toolCallId || u.id || `tc-${Date.now()}-${Math.random()}`;
      const kind   = u.kind || '';
      const label  = pickToolLabel(u);
      const status = (raw._meta && raw._meta.updateParams && raw._meta.updateParams.status) || u.status || 'Pending';
      const startedAt = Date.now();
      patchAgent(agent.id, (cur) => {
        const calls = { ...cur.calls, [id]: {
          id,
          kind,
          label,
          status,
          rawInput: u.rawInput || null,
          rawOutput: u.rawOutput || null,
          content: extractToolContent(u.content),
          locations: Array.isArray(u.locations) ? u.locations.slice() : [],
          startedAt,
          endedAt: null,
        } };
        const inflight = countActive(calls);
        const peak = Math.max(cur.peakInFlight || 0, inflight);
        return { ...cur, status: 'running', inFlight: inflight, peakInFlight: peak, calls, lastActivityAt: startedAt };
      });
      // Mark a new "turn" milestone the first time we see a tool call for
      // a turn that doesn't have one yet.
      patchAgent(agent.id, (cur) => {
        if (cur._turnHasMilestone) return cur;
        const turn = (cur.turn || 0) + 1;
        const ms = (cur.milestones || []).slice();
        ms.push({ kind: 'turn', icon: 'T', label: `turn ${turn}`, t: startedAt });
        if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
        return { ...cur, turn, milestones: ms, _turnHasMilestone: true };
      });
    });

    es.addEventListener('tool_call_update', (ev) => {
      const raw = safeParse(ev.data);
      if (!raw) return;
      bumpTokens(raw);
      const u = (raw.update && typeof raw.update === 'object') ? raw.update : raw;
      const id      = u.toolCallId || u.id;
      if (!id) return;
      const status  = (raw._meta && raw._meta.updateParams && raw._meta.updateParams.status)
                    || u.status || 'Running';
      const done    = (status === 'Completed' || status === 'Failed' || status === 'canceled');
      patchAgent(agent.id, (cur) => {
        const prev = cur.calls[id] || {
          id,
          kind: u.kind || '',
          label: pickToolLabel(u),
          status: 'Pending',
          rawInput: null,
          rawOutput: null,
          content: [],
          locations: [],
          startedAt: Date.now(),
          endedAt: null,
        };
        const nextContent = u.content
          ? mergeToolContent(prev.content, extractToolContent(u.content))
          : prev.content;
        const next = {
          ...prev,
          kind: u.kind || prev.kind,
          label: pickToolLabel(u) || prev.label,
          status,
          rawInput: (u.rawInput != null) ? u.rawInput : prev.rawInput,
          rawOutput: (u.rawOutput != null) ? u.rawOutput : prev.rawOutput,
          content: nextContent,
          locations: Array.isArray(u.locations) && u.locations.length ? u.locations.slice() : prev.locations,
          endedAt: done ? (prev.endedAt || Date.now()) : prev.endedAt,
        };
        const calls = { ...cur.calls, [id]: next };
        return { ...cur, inFlight: countActive(calls), calls, lastActivityAt: Date.now() };
      });
    });

    es.addEventListener('agent_message_chunk', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      bumpTokens(data);
      patchAgent(agent.id, (cur) => ({ ...cur, status: cur.status === 'errored' ? cur.status : 'running', lastActivityAt: Date.now() }));
    });

    es.addEventListener('agent_thought_chunk', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      bumpTokens(data);
    });

    es.addEventListener('user_message_chunk', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      patchAgent(agent.id, (cur) => ({ ...cur, lastUserAt: Date.now(), lastActivityAt: Date.now() }));
    });

    es.addEventListener('prompt_complete', (ev) => {
      const data = safeParse(ev.data);
      bumpTokens(data || {});
      patchAgent(agent.id, (cur) => {
        // Open the next turn slot for a milestone on the next tool_call.
        const turn = cur.turn || 0;
        const ms = (cur.milestones || []).slice();
        if (turn > 0) {
          ms.push({ kind: 'turn-end', icon: 'D', label: `turn ${turn} done`, t: Date.now() });
          if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
        }
        return { ...cur, status: 'idle', milestones: ms, _turnHasMilestone: false, lastActivityAt: Date.now() };
      });
    });

    // Grok-specific bg task lifecycle.
    const onBgStart = (ev) => {
      const data = safeParse(ev.data);
      const u = (data && data.update) || (data && data.params && data.params.update) || data;
      if (!u) return;
      const cmd = u.command || u.cmd || '';
      pushMilestone(agent.id, { kind: 'bg-start', icon: 'U', label: `started ${truncCmd(cmd)}`, t: Date.now() });
    };
    const onBgEnd = (ev) => {
      const data = safeParse(ev.data);
      const u = (data && data.update) || (data && data.params && data.params.update) || data;
      if (!u) return;
      const snap = u.task_snapshot || {};
      const cmd = snap.command || u.command || '';
      pushMilestone(agent.id, { kind: 'bg-end', icon: 'V', label: `finished ${truncCmd(cmd)}`, t: Date.now() });
    };
    es.addEventListener('task_backgrounded', onBgStart);
    es.addEventListener('x.ai/task_backgrounded', onBgStart);
    es.addEventListener('task_completed', onBgEnd);
    es.addEventListener('x.ai/task_completed', onBgEnd);

    es.addEventListener('error', () => {
      // EventSource will reconnect on its own; flag the card meanwhile so
      // the user sees something is off.
      patchAgent(agent.id, (cur) => ({ ...cur, status: cur.status === 'running' ? 'errored' : cur.status }));
    });
  }, [patchAgent, pushMilestone]);

  const closeStreamFor = useCallback((id) => {
    const es = streamsRef.current.get(id);
    if (es) {
      try { es.close(); } catch { /* ignore */ }
      streamsRef.current.delete(id);
    }
  }, []);

  // ── bg-terminal polling for the currently-visible agent set ────────────

  useEffect(() => {
    let alive = true;
    const tickOnce = async () => {
      if (document.hidden) return;
      const list = agentsRef.current;
      if (!list || !list.length) return;
      // Poll in parallel; cap concurrency by the visible set anyway.
      await Promise.all(list.map(async (a) => {
        try {
          const res = await api.terminals.list(a.id);
          if (!alive) return;
          const terms = (res && Array.isArray(res.terminals)) ? res.terminals : [];
          // Detect newly-seen URLs and emit a milestone the first time each
          // unique URL appears for the agent.
          patchAgent(a.id, (cur) => {
            const knownUrls = new Set((cur.bgTerminals || []).map(t => t.url).filter(Boolean));
            const ms = (cur.milestones || []).slice();
            for (const t of terms) {
              if (t.url && !knownUrls.has(t.url)) {
                const port = (t.url.match(/:(\d+)/) || [])[1];
                ms.push({
                  kind: 'url',
                  icon: 'W',
                  label: port ? `:${port} bound` : 'URL bound',
                  t: Date.now(),
                });
                knownUrls.add(t.url);
              }
            }
            if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
            return { ...cur, bgTerminals: terms, milestones: ms };
          });
        } catch { /* keep stale on transient errors */ }
      }));
    };
    tickOnce();
    bgPollTimerRef.current = setInterval(tickOnce, BG_TERMINALS_POLL_MS);
    return () => {
      alive = false;
      if (bgPollTimerRef.current) {
        clearInterval(bgPollTimerRef.current);
        bgPollTimerRef.current = null;
      }
    };
  }, [agents, patchAgent]);

  // Tick once a second so live durations (in-flight tool dur, bg elapsed)
  // refresh without us spamming sessionStorage.
  useEffect(() => {
    const t = setInterval(() => setTick((v) => (v + 1) % 1_000_000), 1000);
    return () => clearInterval(t);
  }, []);

  // ── agent list polling ─────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    try {
      const list = await api.listAgents();
      const arr = Array.isArray(list) ? list : (list && list.agents) || [];
      const fids = filterIdsRef.current;
      const useFilter = Array.isArray(fids) && fids.length > 0 && !showAllRef.current;
      let filtered;
      if (useFilter) {
        const allow = new Set(fids);
        filtered = arr.filter(a => allow.has(a.id));
      } else {
        filtered = showArchivedRef.current ? arr : arr.filter(a => !a.archived);
      }
      setAgents(filtered.sort((a, b) => {
        const sa = STATUS_RANK[normaliseStatus(a.status)] ?? 9;
        const sb = STATUS_RANK[normaliseStatus(b.status)] ?? 9;
        if (sa !== sb) return sa - sb;
        return (a.name || a.id).localeCompare(b.name || b.id);
      }));
    } catch {
      // server might be down briefly; keep the previous view.
    }
  }, []);

  useEffect(() => {
    refresh();
    // SSE push for instant updates. The 5s poll stays as a safety net when
    // the EventSource fails (older server or temporary network loss).
    let sseAlive = false;
    let es;
    try {
      es = new EventSource('/api/agents/stream');
      es.addEventListener('open', () => { sseAlive = true; });
      es.addEventListener('agents_snapshot', () => { refresh(); });
      es.addEventListener('agent_added',   () => { refresh(); });
      es.addEventListener('agent_removed', () => { refresh(); });
      es.addEventListener('agent_updated', () => { refresh(); });
      es.addEventListener('agent_status',  () => { refresh(); });
      es.addEventListener('error', () => { sseAlive = false; });
    } catch { /* fall through to polling */ }
    pollTimerRef.current = setInterval(() => {
      if (document.hidden) return;
      if (sseAlive) return;
      refresh();
    }, LIST_POLL_MS);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
      if (es) { try { es.close(); } catch { /* ignore */ } }
    };
  }, [refresh]);

  // Re-filter immediately when either toggle changes.
  useEffect(() => { refresh(); }, [showArchived, showAll, refresh]);

  // Open / close streams to mirror the current agent set.
  useEffect(() => {
    const wantIds = new Set(agents.map(a => a.id));
    for (const a of agents) openStreamFor(a);
    for (const existing of Array.from(streamsRef.current.keys())) {
      if (!wantIds.has(existing)) closeStreamFor(existing);
    }
  }, [agents, openStreamFor, closeStreamFor]);

  // Final teardown: close every stream when the component unmounts.
  useEffect(() => {
    const streams = streamsRef.current;
    return () => {
      for (const es of streams.values()) {
        try { es.close(); } catch { /* ignore */ }
      }
      streams.clear();
    };
  }, []);

  // ── group toggle handler (stable across renders) ───────────────────────

  const toggleGroup = useCallback((agentId, groupKey) => {
    setExpandedGroups((prev) => {
      const key = `${agentId}:${groupKey}`;
      const next = { ...prev };
      if (next[key]) delete next[key]; else next[key] = true;
      return next;
    });
  }, []);

  // ── derive nodes + edges ───────────────────────────────────────────────

  const { nodes, edges } = useMemo(() => {
    // suppress unused-tick lint; the tick is here so the live duration
    // closures recompute every second.
    void tick;
    const focusIds = (hasFilter && showAll) ? new Set(filterIds) : null;
    const agentNodes = layoutAgents(agents).map((n) => {
      const st = agentState[n.data.agentId] || {};
      const isFocus = focusIds ? focusIds.has(n.data.agentId) : false;
      return {
        ...n,
        className: isFocus ? 'flow-node--focus' : undefined,
        data: {
          ...n.data,
          status:   normaliseStatus(st.status || n.data.status),
          tokens:   st.tokens || 0,
          inFlight: st.inFlight || 0,
          tokensHistory: Array.isArray(st.tokensHistory) ? st.tokensHistory : [],
          isFocus,
        },
      };
    });

    const auxNodes = [];
    const auxEdges = [];
    const COL_WIDTH = 220;
    const ROW_HEIGHT = 64;
    const COLS = 4;

    agentNodes.forEach((agentNode) => {
      const st = agentState[agentNode.data.agentId];
      if (!st) return;

      // — Tool calls + grouping —
      if (st.calls && Object.keys(st.calls).length) {
        const sortedCalls = Object.values(st.calls).slice().sort((a, b) => {
          const at = a.startedAt || 0, bt = b.startedAt || 0;
          return at - bt;
        });
        const items = groupToolCalls(sortedCalls);
        let slot = 0;
        items.forEach((entry, idxInList) => {
          if (entry.type === 'group') {
            const groupKey = `${entry.kind}@${entry.startedAt}`;
            const expanded = !!expandedGroups[`${agentNode.data.agentId}:${groupKey}`];
            const nodeId = `group:${agentNode.data.agentId}:${groupKey}`;
            const gx = 320 + (slot % COLS) * COL_WIDTH;
            const gy = agentNode.position.y + Math.floor(slot / COLS) * ROW_HEIGHT;
            auxNodes.push({
              id: nodeId,
              type: 'group',
              position: { x: gx, y: gy },
              draggable: false,
              selectable: true,
              data: {
                kind: entry.kind,
                count: entry.count,
                totalMs: entry.totalMs,
                failedCount: entry.failedCount,
                expanded,
                onToggle: () => toggleGroup(agentNode.data.agentId, groupKey),
              },
            });
            const groupActive = !entry.endedAt;
            auxEdges.push({
              id: `edge:${agentNode.id}->${nodeId}`,
              source: agentNode.id,
              target: nodeId,
              animated: groupActive,
              style: {
                stroke: entry.failedCount ? 'var(--red)' : (groupActive ? 'var(--teal)' : 'var(--dim)'),
                strokeWidth: 1.4,
                opacity: groupActive ? 1 : 0.7,
              },
            });
            slot += 1;
            if (expanded) {
              // Stack expanded children below the group node.
              entry.items.forEach((call, j) => {
                const childId = `tool:${agentNode.data.agentId}:${call.id}`;
                const childX = gx;
                const childY = gy + (j + 1) * 38;
                const inactive = !!call.endedAt;
                auxNodes.push({
                  id: childId,
                  type: 'tool',
                  position: { x: childX, y: childY },
                  draggable: false,
                  selectable: true,
                  data: {
                    id: call.id,
                    kind: call.kind,
                    label: call.label,
                    status: call.status,
                    rawInput: call.rawInput,
                    rawOutput: call.rawOutput,
                    content: call.content,
                    locations: call.locations,
                    startedAt: call.startedAt,
                    endedAt: call.endedAt,
                  },
                  style: { opacity: inactive ? 0.85 : 1 },
                  className: 'flow-tool-node-wrap flow-tool-node-wrap--grouped',
                });
                auxEdges.push({
                  id: `edge:${nodeId}->${childId}`,
                  source: nodeId,
                  target: childId,
                  animated: !call.endedAt && (call.status === 'Pending' || call.status === 'Running' || call.status === 'in_progress'),
                  style: {
                    stroke: (call.status === 'Failed' ? 'var(--red)' : (call.endedAt ? 'var(--dim)' : 'var(--teal)')),
                    strokeWidth: 1,
                    opacity: call.endedAt ? 0.5 : 0.9,
                  },
                });
              });
              // Push the slot pointer past the expanded run so the next item
              // doesn't overlap.
              const extraRows = Math.ceil(entry.items.length * 38 / ROW_HEIGHT);
              slot += extraRows;
            }
          } else {
            const call = entry.call;
            const nodeId = `tool:${agentNode.data.agentId}:${call.id}`;
            const inactive = !!call.endedAt;
            auxNodes.push({
              id: nodeId,
              type: 'tool',
              position: {
                x: 320 + (slot % COLS) * COL_WIDTH,
                y: agentNode.position.y + Math.floor(slot / COLS) * ROW_HEIGHT,
              },
              draggable: false,
              selectable: true,
              data: {
                id: call.id,
                kind: call.kind,
                label: call.label,
                status: call.status,
                rawInput: call.rawInput,
                rawOutput: call.rawOutput,
                content: call.content,
                locations: call.locations,
                startedAt: call.startedAt,
                endedAt: call.endedAt,
              },
              style: inactive ? { opacity: 0.85 } : { opacity: 1 },
            });
            auxEdges.push({
              id: `edge:${agentNode.id}->${nodeId}`,
              source: agentNode.id,
              target: nodeId,
              animated: !call.endedAt && (call.status === 'Pending' || call.status === 'Running' || call.status === 'in_progress'),
              style: {
                stroke: (call.status === 'Failed' ? 'var(--red)' : (call.endedAt ? 'var(--dim)' : 'var(--teal)')),
                strokeWidth: 1.2,
                opacity: call.endedAt ? 0.55 : 1,
              },
            });
            slot += 1;
          }
        });
      }

      // — Background-task nodes (stacked below the agent) —
      if (Array.isArray(st.bgTerminals) && st.bgTerminals.length) {
        // Show running first, then a few most-recent exited.
        const running = st.bgTerminals.filter(t => !t.exited);
        const exited  = st.bgTerminals.filter(t => t.exited);
        const visible = running.concat(exited).slice(0, BG_NODES_VISIBLE);
        visible.forEach((t, j) => {
          const bgId = `bg:${agentNode.data.agentId}:${t.id}`;
          auxNodes.push({
            id: bgId,
            type: 'bgTask',
            position: {
              x: agentNode.position.x,
              y: agentNode.position.y + 120 + j * BG_NODE_VERTICAL_GAP,
            },
            draggable: false,
            selectable: false,
            data: {
              id: t.id,
              command: t.command || '',
              cwd: t.cwd || '',
              exited: !!t.exited,
              exitStatus: t.exitStatus || null,
              url: t.url || null,
              startedAt: t.startedAt || null,
              endedAt: t.endedAt || null,
            },
          });
          auxEdges.push({
            id: `edge:${agentNode.id}->${bgId}`,
            source: agentNode.id,
            sourceHandle: 'bg',
            target: bgId,
            targetHandle: 'bg',
            animated: !t.exited,
            style: {
              stroke: t.exited ? 'var(--dim)' : 'var(--amber)',
              strokeWidth: 1.2,
              opacity: t.exited ? 0.55 : 0.95,
            },
          });
        });
      }

      // — Milestone strip (top of canvas) per-agent —
      // In scoped mode we show a single strip at canvas top. In global mode
      // each agent's strip sits just above its row so multiple conversations
      // don't fight for the same X scale.
      if (Array.isArray(st.milestones) && st.milestones.length) {
        const ms = st.milestones;
        const tMin = ms[0].t;
        const tMax = ms[ms.length - 1].t;
        const W = 760;
        const strip = ms.slice(-MILESTONE_CAP);
        strip.forEach((m, j) => {
          const baseY = agents.length === 1
            ? 8
            : (agentNode.position.y - 56);
          const span = Math.max(1, tMax - tMin);
          const fx = strip.length === 1 ? 0 : ((m.t - tMin) / span) * W;
          const x = 0 + fx;
          auxNodes.push({
            id: `ms:${agentNode.data.agentId}:${j}:${m.t}:${m.kind}`,
            type: 'milestone',
            position: { x, y: baseY },
            draggable: false,
            selectable: false,
            data: m,
          });
        });
      }
    });

    return { nodes: [...agentNodes, ...auxNodes], edges: auxEdges };
  }, [agents, agentState, hasFilter, showAll, filterIds, expandedGroups, toggleGroup, tick]);

  // ── handlers ───────────────────────────────────────────────────────────

  const onNodeClick = useCallback((_ev, node) => {
    if (node.type === 'agent') {
      const id = node.data && node.data.agentId;
      if (id) window.location.hash = `#/agents/${encodeURIComponent(id)}`;
    }
    // Group toggle is handled inside the node so we don't double-fire on clicks
    // through the GroupNode div.
  }, []);

  const handleFit = useCallback(() => {
    try { fitView({ padding: 0.2, duration: 250 }); } catch { /* ignore */ }
  }, [fitView]);

  // Auto-fit whenever the visible agent set changes (spawn, archive,
  // disconnect filter, show-all toggle). Skip while the user is mid-
  // interaction by deferring to a microtask after layout.
  const prevAgentIdsRef = useRef('');
  useEffect(() => {
    const sig = agents.map(a => a.id).sort().join(',');
    if (sig === prevAgentIdsRef.current) return;
    prevAgentIdsRef.current = sig;
    if (!agents.length) return;
    const raf = requestAnimationFrame(() => {
      try { fitView({ padding: 0.2, duration: 250 }); } catch { /* ignore */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [agents, fitView]);

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <section className={`system-page system-page--flow${scoped ? ' system-page--flow-scoped' : ''}`}>
      <div className="flow-toolbar">
        {scoped
          ? <h2 className="system-page-title flow-toolbar__title">Conversation flow</h2>
          : <h2 className="system-page-title flow-toolbar__title">{hasFilter ? 'All conversations' : 'Live agent flow'}</h2>}
        <div className="flow-toolbar__spacer" />
        <button type="button" className="flow-toolbar__btn" onClick={refresh}>refresh</button>
        <button type="button" className="flow-toolbar__btn" onClick={handleFit}>fit view</button>
        <button
          type="button"
          className={`flow-toolbar__btn${statsOpen ? ' flow-toolbar__btn--on' : ''}`}
          onClick={() => setStatsOpen(v => !v)}
          title="toggle stats panel"
        >
          stats
        </button>
        {hasFilter && (
          <button
            type="button"
            className={`flow-toolbar__btn${showAll ? ' flow-toolbar__btn--on' : ''}`}
            onClick={() => setShowAll(v => !v)}
            title={showAll ? 'show only this conversation' : 'show every running agent'}
          >
            {showAll ? 'just this' : 'show all'}
          </button>
        )}
        {!scoped && !hasFilter && (
          <label className="flow-toolbar__check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(ev) => setShowArchived(ev.target.checked)}
            />
            <span>show archived</span>
          </label>
        )}
        <span className="flow-toolbar__count">{agents.length} agent{agents.length === 1 ? '' : 's'}</span>
      </div>
      <div className="flow-canvas">
        {agents.length === 0 ? (
          <div className="flow-empty">no agents yet. spawn one from the conversations view.</div>
        ) : (
          <>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={onNodeClick}
              fitView
              proOptions={{ hideAttribution: true }}
              minZoom={0.3}
              maxZoom={1.5}
            >
              <Background gap={24} size={1} color="var(--border)" />
              <Controls showInteractive={false} />
            </ReactFlow>
            <FlowTotalsOverlay agents={agents} agentState={agentState} />
            {statsOpen && (
              <FlowStatsPanel
                agents={agents}
                agentState={agentState}
                onClose={() => setStatsOpen(false)}
                tick={tick}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

const TOKEN_HISTORY_KEY = (id) => `grok-remote.flowTokens.${id}`;
const TOKEN_HISTORY_MAX = 60;

function loadTokenHistory(id) {
  try {
    const raw = sessionStorage.getItem(TOKEN_HISTORY_KEY(id));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(p => p && typeof p.t === 'number' && typeof p.v === 'number').slice(-TOKEN_HISTORY_MAX);
  } catch { return []; }
}

function saveTokenHistory(id, history) {
  try {
    sessionStorage.setItem(TOKEN_HISTORY_KEY(id), JSON.stringify(history.slice(-TOKEN_HISTORY_MAX)));
  } catch { /* quota or disabled storage: silent */ }
}

function countActive(calls) {
  let n = 0;
  for (const c of Object.values(calls)) {
    if (!c.endedAt) n++;
  }
  return n;
}

// Extract a short readable label for a tool call from its update object.
// Prefer the ACP-provided title, then a synthesized one from kind + rawInput.
function pickToolLabel(u) {
  if (!u) return 'tool';
  if (typeof u.title === 'string' && u.title.trim()) return u.title.trim();
  const ri = u.rawInput;
  if (ri && typeof ri === 'object') {
    if (typeof ri.command === 'string' && ri.command.trim()) return ri.command.trim();
    if (typeof ri.cmd === 'string' && ri.cmd.trim()) return ri.cmd.trim();
    if (typeof ri.path === 'string' && ri.path.trim()) return `${u.kind || 'tool'}: ${ri.path.trim()}`;
    if (typeof ri.file_path === 'string' && ri.file_path.trim()) return `${u.kind || 'tool'}: ${ri.file_path.trim()}`;
    if (typeof ri.url === 'string' && ri.url.trim()) return ri.url.trim();
  }
  if (typeof u.kind === 'string' && u.kind.trim()) return u.kind.trim();
  return 'tool';
}

// Normalize tool content blocks to a stable shape: [{kind, text}].
function extractToolContent(content) {
  if (!content) return [];
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((b) => {
    if (!b || typeof b !== 'object') return null;
    if (b.type === 'content' || b.type === 'text') {
      const inner = (b.content && b.content.text) || b.text || b.content || '';
      return { kind: 'text', text: typeof inner === 'string' ? inner : JSON.stringify(inner) };
    }
    if (b.text) return { kind: 'text', text: String(b.text) };
    if (b.content && typeof b.content === 'string') return { kind: 'text', text: b.content };
    return { kind: b.type || 'block', text: JSON.stringify(b) };
  }).filter(Boolean);
}

// Concat new content blocks onto existing ones, deduplicating exact matches
// at the tail so repeated full snapshots don't double up.
function mergeToolContent(prev, next) {
  if (!Array.isArray(prev) || !prev.length) return next;
  if (!Array.isArray(next) || !next.length) return prev;
  const last = prev[prev.length - 1];
  if (last && next[0] && last.kind === next[0].kind && last.text === next[0].text) {
    return prev.concat(next.slice(1));
  }
  return prev.concat(next);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

function truncCmd(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return t || '(no command)';
  return t.slice(0, 37) + '...';
}

function FlowTotalsOverlay({ agents, agentState }) {
  let totalTokens = 0;
  let totalInFlight = 0;
  let runningAgents = 0;
  let bgRunning = 0;
  for (const a of agents) {
    const st = agentState[a.id] || {};
    const tok = (typeof st.tokens === 'number' && st.tokens > 0)
      ? st.tokens
      : (typeof a.totalTokens === 'number' ? a.totalTokens : 0);
    totalTokens += tok || 0;
    totalInFlight += (typeof st.inFlight === 'number' ? st.inFlight : 0);
    const status = st.status || a.status;
    if (status === 'running') runningAgents++;
    if (Array.isArray(st.bgTerminals)) {
      for (const t of st.bgTerminals) if (!t.exited) bgRunning++;
    }
  }
  if (!totalTokens && !totalInFlight && !runningAgents && !bgRunning) return null;
  return (
    <div className="flow-totals">
      {runningAgents > 0 && (
        <span className="flow-totals__cell" title={`${runningAgents} agent${runningAgents === 1 ? '' : 's'} running`}>
          <span className="flow-totals__dot flow-totals__dot--running" />
          {runningAgents} running
        </span>
      )}
      {totalInFlight > 0 && (
        <span className="flow-totals__cell" title={`${totalInFlight} tool call${totalInFlight === 1 ? '' : 's'} in flight across all agents`}>
          <span className="flow-totals__dot flow-totals__dot--inflight" />
          {totalInFlight} tool{totalInFlight === 1 ? '' : 's'}
        </span>
      )}
      {bgRunning > 0 && (
        <span className="flow-totals__cell flow-totals__cell--bg" title={`${bgRunning} bg shell${bgRunning === 1 ? '' : 's'} running`}>
          <span className="flow-totals__dot flow-totals__dot--bg" />
          {bgRunning} bg
        </span>
      )}
      {totalTokens > 0 && (
        <span className="flow-totals__cell flow-totals__cell--tokens" title={`${totalTokens.toLocaleString()} tokens across all agents`}>
          {fmtTokens(totalTokens)} tok
        </span>
      )}
    </div>
  );
}

// Right-side collapsible stats overlay. Shows aggregate metrics across the
// currently-visible agents: token chart, tools-per-turn bars, top-N kinds,
// avg duration per kind, plus a strip of counters.
function FlowStatsPanel({ agents, agentState, onClose, tick }) {
  void tick; // forces "time since last activity" to refresh.

  const stats = useMemo(() => {
    // Merge all agent slices into a single set of stats.
    const allHist = [];
    let totalCalls = 0;
    let totalTurns = 0;
    let totalTokens = 0;
    let peakInFlight = 0;
    let longestMs = 0;
    let lastActivityAt = 0;
    let lastUserAt = 0;
    const perKind = new Map(); // kind -> { count, totalMs }
    const perTurn = new Map(); // turn -> count (approx; we share across agents)

    for (const a of agents) {
      const st = agentState[a.id] || {};
      if (Array.isArray(st.tokensHistory)) for (const p of st.tokensHistory) allHist.push(p);
      totalTokens += (typeof st.tokens === 'number' ? st.tokens : 0);
      totalTurns += (st.turn || 0);
      if (typeof st.peakInFlight === 'number' && st.peakInFlight > peakInFlight) peakInFlight = st.peakInFlight;
      if (st.lastActivityAt && st.lastActivityAt > lastActivityAt) lastActivityAt = st.lastActivityAt;
      if (st.lastUserAt && st.lastUserAt > lastUserAt) lastUserAt = st.lastUserAt;
      if (st.calls) {
        const calls = Object.values(st.calls);
        totalCalls += calls.length;
        // Group by turn boundaries inferred from sequential ordering against
        // milestones. Cheap fallback: just bucket by turn count of the agent.
        // We approximate per-turn buckets by spreading calls evenly.
        const turn = st.turn || 1;
        for (const c of calls) {
          const kind = c.kind || 'tool';
          const slot = perKind.get(kind) || { count: 0, totalMs: 0 };
          slot.count += 1;
          const end = c.endedAt || (c.startedAt ? Date.now() : 0);
          const dur = (c.startedAt && end) ? Math.max(0, end - c.startedAt) : 0;
          slot.totalMs += dur;
          if (dur > longestMs) longestMs = dur;
          perKind.set(kind, slot);
        }
        // Per-turn aggregation: assume each turn has the same average; the
        // user-facing chart is approximate. To get a better signal we walk
        // milestones if present.
        if (Array.isArray(st.milestones) && st.milestones.length) {
          let curTurn = 0;
          const turnBoundaries = [];
          for (const m of st.milestones) {
            if (m.kind === 'turn') {
              curTurn += 1;
              turnBoundaries.push({ turn: curTurn, t: m.t });
            }
          }
          for (const c of calls) {
            const ts = c.startedAt || 0;
            let t = 1;
            for (const tb of turnBoundaries) {
              if (ts >= tb.t) t = tb.turn;
              else break;
            }
            perTurn.set(t, (perTurn.get(t) || 0) + 1);
          }
        } else if (calls.length) {
          perTurn.set(turn, (perTurn.get(turn) || 0) + calls.length);
        }
      }
    }

    allHist.sort((a, b) => a.t - b.t);

    const topKinds = [...perKind.entries()]
      .map(([k, v]) => ({ kind: k, count: v.count, avgMs: v.count ? Math.round(v.totalMs / v.count) : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const turns = [...perTurn.entries()].sort((a, b) => a[0] - b[0]);

    return {
      tokensHist: allHist,
      totalCalls,
      totalTurns,
      totalTokens,
      peakInFlight,
      longestMs,
      lastActivityAt,
      lastUserAt,
      topKinds,
      perTurnBars: turns,
    };
  }, [agents, agentState]);

  const sincePart = (ts) => {
    if (!ts) return 'never';
    const d = Date.now() - ts;
    if (d < 1500) return 'just now';
    if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
    if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
    return `${Math.round(d / 3_600_000)}h ago`;
  };

  // Build a bigger token sparkline. Reuse buildSparkPath but tune dims.
  const tokSpark = stats.tokensHist.length >= 2
    ? buildSparkPath(stats.tokensHist, 280, 70)
    : null;

  // Tools-per-turn bars. Max bar count visible: 10.
  const bars = stats.perTurnBars.slice(-10);
  const maxBar = bars.reduce((m, [, v]) => Math.max(m, v), 1);

  return (
    <aside className="flow-stats" role="complementary" aria-label="flow stats">
      <header className="flow-stats__head">
        <h3 className="flow-stats__title">stats</h3>
        <button
          type="button"
          className="flow-stats__close"
          onClick={onClose}
          title="close stats panel"
        >x</button>
      </header>

      <section className="flow-stats__section">
        <div className="flow-stats__section-title">tokens over time</div>
        {tokSpark ? (
          <svg className="flow-stats__chart" viewBox="0 0 280 70" preserveAspectRatio="none">
            <path d={tokSpark.area} fill="rgba(94, 234, 212, 0.15)" />
            <path d={tokSpark.line} fill="none" stroke="var(--teal)" strokeWidth="1.4" />
          </svg>
        ) : (
          <div className="flow-stats__empty">not enough samples yet.</div>
        )}
        <div className="flow-stats__row">
          <span className="flow-stats__row-key">total</span>
          <span className="flow-stats__row-val flow-stats__row-val--teal">{stats.totalTokens ? fmtTokens(stats.totalTokens) : '0'}</span>
        </div>
      </section>

      <section className="flow-stats__section">
        <div className="flow-stats__section-title">tools per turn</div>
        {bars.length ? (
          <div className="flow-stats__bars">
            {bars.map(([turn, v]) => (
              <div className="flow-stats__bar" key={`bar-${turn}`} title={`turn ${turn}: ${v} call${v === 1 ? '' : 's'}`}>
                <div
                  className="flow-stats__bar-fill"
                  style={{ height: `${Math.max(4, (v / maxBar) * 56)}px` }}
                />
                <div className="flow-stats__bar-x">{turn}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flow-stats__empty">no turns yet.</div>
        )}
      </section>

      <section className="flow-stats__section">
        <div className="flow-stats__section-title">top tool kinds</div>
        {stats.topKinds.length ? (
          <ul className="flow-stats__list">
            {stats.topKinds.map((k) => (
              <li className="flow-stats__list-row" key={k.kind}>
                <span className="flow-stats__kind">{k.kind || 'tool'}</span>
                <span className="flow-stats__list-meta">{k.count} . avg {fmtDuration(k.avgMs)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flow-stats__empty">no tool calls yet.</div>
        )}
      </section>

      <section className="flow-stats__section flow-stats__section--counters">
        <Counter label="tool calls" value={stats.totalCalls} />
        <Counter label="turns"      value={stats.totalTurns} />
        <Counter label="peak parallel" value={stats.peakInFlight} />
        <Counter label="longest"    value={fmtDuration(stats.longestMs) || '0ms'} />
        <Counter label="last activity" value={sincePart(stats.lastActivityAt)} />
        <Counter label="last user msg" value={sincePart(stats.lastUserAt)} />
      </section>
    </aside>
  );
}

function Counter({ label, value }) {
  return (
    <div className="flow-stats__counter">
      <div className="flow-stats__counter-val">{value == null || value === 0 ? '0' : value}</div>
      <div className="flow-stats__counter-key">{label}</div>
    </div>
  );
}

export default function FlowApp(props) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}
