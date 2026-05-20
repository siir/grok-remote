// Live agent flow page.
//
// Renders one node per agent on a React Flow canvas. For each agent we open
// an SSE stream and translate the events into:
//   - node status   ("idle" / "running" / "errored" / "disconnected")
//   - token totals  (from event _meta.totalTokens when present)
//   - ephemeral tool-call satellite nodes connected by animated edges
//
// Click a node to jump to that agent's conversation. Toolbar exposes refresh
// (re-poll the list now), fit-view, and a toggle to include archived agents.

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

// How long a finished tool-call node lingers on the canvas before fading out.
const TOOL_NODE_LINGER_MS = 1800;
// How often we re-poll the agent list. SSE keeps individual cards live; this
// is only here to pick up newly-spawned or deleted agents.
const LIST_POLL_MS = 5000;

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
  const status = data.status || 'pending';
  return (
    <div className={`flow-tool-node flow-tool-node--${status.toLowerCase()}`}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <Handle type="source" position={Position.Left} className="flow-handle" />
      <div className="flow-tool-node__title" title={data.title}>{data.title || 'tool'}</div>
      <div className="flow-tool-node__status">{status}</div>
    </div>
  );
}

const NODE_TYPES = { agent: AgentNode, tool: ToolNode };

// ── helpers ───────────────────────────────────────────────────────────────

function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Lay agent cards out in a column on the left, leaving the right half of the
// canvas for tool-call satellites. React Flow handles panning + zoom.
function layoutAgents(agents) {
  return agents.map((a, i) => ({
    id: `agent:${a.id}`,
    type: 'agent',
    position: { x: 0, y: i * 130 },
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
  const [agentState, setAgentState]       = useState({}); // id -> { status, tokens, inFlight, calls: {id -> {title, status, expiresAt}} }
  const { fitView } = useReactFlow();

  // Mutable refs that survive re-renders without re-subscribing effects.
  const streamsRef    = useRef(new Map()); // id -> EventSource
  const pollTimerRef  = useRef(null);
  const sweepTimerRef = useRef(null);

  // Keep `showArchived` reachable from the polling effect without re-running it.
  const showArchivedRef = useRef(showArchived);
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);
  const filterIdsRef = useRef(filterIds);
  useEffect(() => { filterIdsRef.current = filterIds; }, [filterIds]);
  const showAllRef = useRef(showAll);
  useEffect(() => { showAllRef.current = showAll; }, [showAll]);

  // ── pure helpers that mutate state immutably ───────────────────────────

  const patchAgent = useCallback((id, patch) => {
    setAgentState((prev) => {
      // Hydrate tokensHistory from sessionStorage on first touch so the
      // sparkline survives page reloads + view remounts.
      let cur = prev[id];
      if (!cur) {
        const persisted = loadTokenHistory(id);
        const lastTok = persisted.length ? persisted[persisted.length - 1].v : 0;
        cur = { status: 'idle', tokens: lastTok, inFlight: 0, calls: {}, tokensHistory: persisted };
      }
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      // Persist when history grew. Cheap; runs at most ~2/sec per agent.
      if (next.tokensHistory && next.tokensHistory !== cur.tokensHistory) {
        saveTokenHistory(id, next.tokensHistory);
      }
      return { ...prev, [id]: next };
    });
  }, []);

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
          // Cap to 30 samples to keep memory bounded.
          if (hist.length > 30) hist.splice(0, hist.length - 30);
          return { ...cur, tokens: t, tokensHistory: hist };
        });
      }
    };

    es.addEventListener('agent_status', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      const status = normaliseStatus(data.status || data.state);
      patchAgent(agent.id, (cur) => ({ ...cur, status }));
    });

    es.addEventListener('tool_call', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      bumpTokens(data);
      const id     = data.toolCallId || data.id || `tc-${Date.now()}-${Math.random()}`;
      const title  = data.title || (data.rawInput && data.rawInput.command) || data.kind || 'tool';
      const status = (data._meta && data._meta.updateParams && data._meta.updateParams.status) || 'Pending';
      patchAgent(agent.id, (cur) => {
        const calls = { ...cur.calls, [id]: { title, status, expiresAt: null } };
        return { ...cur, status: 'running', inFlight: countActive(calls), calls };
      });
    });

    es.addEventListener('tool_call_update', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      bumpTokens(data);
      const id      = data.toolCallId || data.id;
      const status  = (data._meta && data._meta.updateParams && data._meta.updateParams.status)
                    || data.status || 'Running';
      const title   = data.title;
      const done    = status === 'Completed' || status === 'Failed';
      patchAgent(agent.id, (cur) => {
        const prev = cur.calls[id] || { title: title || 'tool', status: 'Pending' };
        const next = {
          title:  title || prev.title,
          status,
          expiresAt: done ? Date.now() + TOOL_NODE_LINGER_MS : null,
        };
        const calls = { ...cur.calls, [id]: next };
        return { ...cur, inFlight: countActive(calls), calls };
      });
    });

    es.addEventListener('agent_message_chunk', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      bumpTokens(data);
      patchAgent(agent.id, (cur) => ({ ...cur, status: cur.status === 'errored' ? cur.status : 'running' }));
    });

    es.addEventListener('agent_thought_chunk', (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      bumpTokens(data);
    });

    es.addEventListener('prompt_complete', (ev) => {
      const data = safeParse(ev.data);
      bumpTokens(data || {});
      patchAgent(agent.id, (cur) => ({ ...cur, status: 'idle' }));
    });

    es.addEventListener('error', () => {
      // EventSource will reconnect on its own; flag the card meanwhile so
      // the user sees something is off.
      patchAgent(agent.id, (cur) => ({ ...cur, status: cur.status === 'running' ? 'errored' : cur.status }));
    });
  }, [patchAgent]);

  const closeStreamFor = useCallback((id) => {
    const es = streamsRef.current.get(id);
    if (es) {
      try { es.close(); } catch { /* ignore */ }
      streamsRef.current.delete(id);
    }
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

  // Periodic sweep to expire faded-out tool nodes.
  useEffect(() => {
    sweepTimerRef.current = setInterval(() => {
      const now = Date.now();
      setAgentState((prev) => {
        let changed = false;
        const out = {};
        for (const [id, st] of Object.entries(prev)) {
          const keptCalls = {};
          for (const [cid, c] of Object.entries(st.calls || {})) {
            if (c.expiresAt && c.expiresAt < now) { changed = true; continue; }
            keptCalls[cid] = c;
          }
          out[id] = (keptCalls === st.calls) ? st : { ...st, calls: keptCalls, inFlight: countActive(keptCalls) };
        }
        return changed ? out : prev;
      });
    }, 600);
    return () => {
      if (sweepTimerRef.current) clearInterval(sweepTimerRef.current);
      sweepTimerRef.current = null;
    };
  }, []);

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

  // ── derive nodes + edges ───────────────────────────────────────────────

  const { nodes, edges } = useMemo(() => {
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

    const toolNodes = [];
    const toolEdges = [];
    agentNodes.forEach((agentNode) => {
      const st = agentState[agentNode.data.agentId];
      if (!st || !st.calls) return;
      const callIds = Object.keys(st.calls);
      callIds.forEach((cid, j) => {
        const call = st.calls[cid];
        const fading = !!call.expiresAt;
        const nodeId = `tool:${agentNode.data.agentId}:${cid}`;
        toolNodes.push({
          id: nodeId,
          type: 'tool',
          position: {
            x: 320 + (j % 3) * 200,
            y: agentNode.position.y + Math.floor(j / 3) * 70,
          },
          draggable: false,
          selectable: false,
          data: { title: call.title, status: call.status },
          style: fading ? { opacity: 0.45, transition: 'opacity 400ms ease' } : { opacity: 1 },
        });
        toolEdges.push({
          id: `edge:${agentNode.id}->${nodeId}`,
          source: agentNode.id,
          target: nodeId,
          animated: !fading && (call.status === 'Pending' || call.status === 'Running'),
          style: {
            stroke: fading
              ? 'var(--dim)'
              : (call.status === 'Failed' ? 'var(--red)' : 'var(--teal)'),
            strokeWidth: 1.5,
            opacity: fading ? 0.5 : 1,
          },
        });
      });
    });

    return { nodes: [...agentNodes, ...toolNodes], edges: toolEdges };
  }, [agents, agentState, hasFilter, showAll, filterIds]);

  // ── handlers ───────────────────────────────────────────────────────────

  const onNodeClick = useCallback((_ev, node) => {
    if (node.type !== 'agent') return;
    const id = node.data && node.data.agentId;
    if (id) window.location.hash = `#/agents/${encodeURIComponent(id)}`;
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
    // requestAnimationFrame so React has actually committed the new nodes.
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
          </>
        )}
      </div>
    </section>
  );
}

const TOKEN_HISTORY_KEY = (id) => `grok-remote.flowTokens.${id}`;
const TOKEN_HISTORY_MAX = 30;

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
    if (!c.expiresAt) n++;
  }
  return n;
}

function FlowTotalsOverlay({ agents, agentState }) {
  let totalTokens = 0;
  let totalInFlight = 0;
  let runningAgents = 0;
  for (const a of agents) {
    const st = agentState[a.id] || {};
    const tok = (typeof st.tokens === 'number' && st.tokens > 0)
      ? st.tokens
      : (typeof a.totalTokens === 'number' ? a.totalTokens : 0);
    totalTokens += tok || 0;
    totalInFlight += (typeof st.inFlight === 'number' ? st.inFlight : 0);
    const status = st.status || a.status;
    if (status === 'running') runningAgents++;
  }
  if (!totalTokens && !totalInFlight && !runningAgents) return null;
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
      {totalTokens > 0 && (
        <span className="flow-totals__cell flow-totals__cell--tokens" title={`${totalTokens.toLocaleString()} tokens across all agents`}>
          {fmtTokens(totalTokens)} tok
        </span>
      )}
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
