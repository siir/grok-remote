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

// A tool_call whose kind matches this is treated as a sub-agent invocation
// rather than a regular tool. Matches "Agent", "Agent(explore)",
// "agent(planner)", etc. Kept for completeness, but the actual grok signal
// lives in rawInput.variant === "Task" / rawInput.subagent_type, which
// isSubAgentCall() below picks up.
const SUB_AGENT_KIND_RE = /^agent(?:\(.*\))?$/i;

// Treat a tool_call as a sub-agent invocation when ANY of these hold:
//   1. rawInput.variant === "Task"               (grok subagent tool shape)
//   2. rawInput.subagent_type is a string         (subagent kind, e.g. "general-purpose")
//   3. update.kind matches the SUB_AGENT_KIND_RE  (legacy / ACP-style)
// The actual subagent label comes from rawInput.description, then title,
// then rawInput.prompt, then "sub-agent".
function isSubAgentCall(u) {
  if (!u || typeof u !== 'object') return false;
  if (SUB_AGENT_KIND_RE.test(String(u.kind || ''))) return true;
  const ri = u.rawInput;
  if (ri && typeof ri === 'object') {
    if (ri.variant === 'Task') return true;
    if (typeof ri.subagent_type === 'string' && ri.subagent_type) return true;
  }
  return false;
}

function pickSubAgentLabel(u) {
  const ri = (u && u.rawInput) || {};
  return (typeof ri.description === 'string' && ri.description.trim())
    || (typeof u.title === 'string' && u.title.trim())
    || (typeof ri.prompt === 'string' && ri.prompt.trim().split('\n')[0].slice(0, 80))
    || 'sub-agent';
}

// Pluck the sub-agent's session id from a sub record. Two sources:
//   1. SubagentCompleted rawOutput.subagent_id — set when the sub-agent
//      completed inline and emitted its final payload.
//   2. The spawn-ack content text "subagent_id: <uuid>" — used by
//      run_in_background=true spawns (they don't get a SubagentCompleted).
// The caller is expected to cache the result on the sub record so this
// only runs once per sub.
const SUBAGENT_ID_RE = /subagent_id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
function extractSubagentId(sub) {
  if (!sub) return null;
  const ro = sub.rawOutput;
  if (ro && typeof ro === 'object' && typeof ro.subagent_id === 'string' && ro.subagent_id) {
    return ro.subagent_id;
  }
  // bg=true spawn ack: text body lives in either rawOutput.text or the
  // streamed response content blocks.
  if (ro && typeof ro === 'object' && typeof ro.text === 'string') {
    const m = ro.text.match(SUBAGENT_ID_RE);
    if (m) return m[1];
  }
  if (Array.isArray(sub.response)) {
    for (const block of sub.response) {
      const t = block && typeof block.text === 'string' ? block.text : '';
      const m = t.match(SUBAGENT_ID_RE);
      if (m) return m[1];
    }
  }
  return null;
}

// Walk a sub-agent's trace `updates.jsonl` rows and return a flat list of
// child tool-call entries. Mirrors the live applyAgentEventToState reducer
// but lives in a side channel so it doesn't pollute the parent agent's
// state. We only care about tool_call / tool_call_update rows; everything
// else (messages, thoughts, prompt boundaries) is irrelevant for the
// child-tool-node column.
function extractChildCallsFromTrace(traceData) {
  if (!traceData || !Array.isArray(traceData.updates)) return [];
  const byId = new Map(); // toolCallId -> child call record
  for (const row of traceData.updates) {
    if (!row || typeof row !== 'object') continue;
    // updates.jsonl rows from `grok trace` are JSON-RPC envelopes:
    //   { method: "session/update", params: { sessionId, update: {...}, _meta: {...} } }
    // The ACP-style update object lives under params.update; the _meta
    // (with agentTimestampMs + updateParams.status) lives under params._meta.
    // Fall back to the older flat shape just in case.
    const params = (row.params && typeof row.params === 'object') ? row.params : null;
    const u = (params && params.update && typeof params.update === 'object')
      ? params.update
      : ((row.update && typeof row.update === 'object') ? row.update : row);
    const meta = (params && params._meta) || row._meta || {};
    const sessionUpdate = u.sessionUpdate || row.sessionUpdate;
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') continue;
    const id = u.toolCallId || u.id;
    if (!id) continue;
    // Skip sub-sub-agent spawns inside the child for now; deep nesting can
    // come later. We don't render them as nodes anyway.
    if (isSubAgentCall(u)) continue;
    const at = Number.isFinite(meta.agentTimestampMs)
      ? meta.agentTimestampMs
      : (Number.isFinite(row.timestamp) ? row.timestamp * 1000 : Date.now());
    const status = (meta.updateParams && meta.updateParams.status) || u.status || 'Pending';
    const done = (status === 'Completed' || status === 'completed'
                  || status === 'Failed' || status === 'failed'
                  || status === 'canceled');
    const prev = byId.get(id) || {
      id,
      kind: u.kind || '',
      label: pickToolLabel(u),
      status: 'Pending',
      rawInput: null,
      rawOutput: null,
      content: [],
      locations: [],
      startedAt: at,
      endedAt: null,
    };
    const nextContent = u.content
      ? mergeToolContent(prev.content, extractToolContent(u.content))
      : prev.content;
    const merged = {
      ...prev,
      kind: u.kind || prev.kind,
      label: pickToolLabel(u) || prev.label,
      status,
      rawInput: (u.rawInput != null) ? u.rawInput : prev.rawInput,
      rawOutput: (u.rawOutput != null) ? u.rawOutput : prev.rawOutput,
      content: nextContent,
      locations: Array.isArray(u.locations) && u.locations.length ? u.locations.slice() : prev.locations,
      endedAt: done ? (prev.endedAt || at) : prev.endedAt,
    };
    byId.set(id, merged);
  }
  return [...byId.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// Sub-agent layout: cards hang off the LEFT side of the main agent, stacked
// vertically using the same AGENT_GAP-style cadence so future deep nesting
// is easy to extend.
const LAYOUT = {
  AGENT_GAP: 320,    // mirror AGENT_ROW_HEIGHT cadence between siblings
  SUB_AGENT_X: -260, // 240px wide card + 20px gap from parent's left edge
  SUB_AGENT_GAP: 12, // vertical gap between adjacent sub-agent cards
  // Child tool-call nodes hang off the LEFT side of an expanded sub-agent
  // card. They sit further left than the sub-agent column (offset relative
  // to the sub-agent's own x).
  SUB_AGENT_CHILD_X: -220, // delta from sub-agent x: -260 - 220 = -480
  SUB_AGENT_CHILD_GAP: 8,
  TOOL_GAP: 12,      // vertical gap between adjacent tool / group cards in the same column
  BG_GAP: 12,        // vertical gap between adjacent bg-task cards
  AGENT_CLUSTER_GAP: 80, // gap between one agent cluster and the next
};

// Per-node-type closed and (worst-case) open pixel heights. These mirror the
// rendered card geometry in style.css. Open heights are conservative ceilings
// so the running-tally layout never under-reserves space.
const NODE_HEIGHTS = {
  agent:      { closed: 135, open: 135 },     // no expand
  tool:       { closed: 42,  open: 280 },     // closed pill, open body with input/output
  group:      { closed: 56,  open: 56 },      // group head; child rows are tallied separately
  subAgent:   { closed: 138, open: 340 },     // crumb + head + row + snippet; expanded shows prompt/response/stats
  bgTask:     { closed: 78,  open: 78 },      // bg cards never expand right now
  milestone:  { closed: 50,  open: 50 },      // tiny pill
};
// Per-grouped-tool-child row height when a group is expanded (each child
// stacks below its parent group node).
const GROUP_CHILD_ROW = 42;
// Per-grouped-tool-child row height when the child itself is also expanded.
const GROUP_CHILD_ROW_OPEN = 280;

// Milestone strip layout. Time-axis scaling was replaced by index-based
// placement (see flow layout pass). A milestone card is 200px wide; the
// step must be >= that plus a small gap so adjacent nodes never overlap.
// The 2-row y-stagger gives extra breathing room when many events land
// in a short burst.
const MILESTONE_STEP_X = 220;
const MILESTONE_ROW_DY = 32;

// Backoff schedule for sub-agent child trace retries. Used when the session
// dir hasn't been flushed to disk yet (brand-new bg sub-agents). The
// fetchSubChildren machinery retries on this schedule up to MAX_RETRIES,
// then ticks every LIVE_RETRY_MS for as long as the sub-agent is still
// running. Once it ends, we do the final retries and give up.
const SUB_CHILD_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];
const SUB_CHILD_LIVE_RETRY_MS   = 5000;

function nodeKind(typeName, isOpen) {
  const h = NODE_HEIGHTS[typeName] || NODE_HEIGHTS.tool;
  return isOpen ? h.open : h.closed;
}

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
    <div className={`flow-agent-node flow-agent-node--${status}`} data-depth={data.depth || 0}>
      <Handle type="source" position={Position.Right} className="flow-handle" />
      <Handle type="target" position={Position.Right} className="flow-handle" />
      <Handle type="source" id="sub" position={Position.Left} className="flow-handle" />
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
  const open = !!data.isOpen;
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
        onClick={(e) => { e.stopPropagation(); if (data.onToggle) data.onToggle(); }}
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

// Smaller card hanging off the LEFT of the main agent. Visualizes a
// sub-agent (grok's built-in Agent tool, e.g. Agent(explore)). Connection:
// edge from parent's left handle to this node's right handle.
function SubAgentNode({ data }) {
  const status = (data.status || 'pending').toLowerCase();
  const open = !!data.isOpen;
  const dur = (data.endedAt && data.startedAt) ? (data.endedAt - data.startedAt) : null;
  const liveDur = (!data.endedAt && data.startedAt) ? (Date.now() - data.startedAt) : null;
  const showDur = dur != null ? fmtDuration(dur) : (liveDur != null ? `${fmtDuration(liveDur)}...` : '');
  const promptText = typeof data.prompt === 'string'
    ? data.prompt
    : (data.prompt ? safeStringify(data.prompt) : '');
  // Prefer the rich SubagentCompleted rawOutput.output as the canonical final
  // response (it's the actual subagent message). Fall back to the streamed
  // content blocks if rawOutput hasn't arrived yet.
  const ro = data.rawOutput;
  const isSubagentFinal = ro && ro.type === 'SubagentCompleted';
  const finalOutput = isSubagentFinal && typeof ro.output === 'string' ? ro.output.trim() : '';
  const streamedText = Array.isArray(data.response)
    ? data.response.map(c => c.text).join('\n').trim()
    : (typeof data.response === 'string' ? data.response : '');
  const responseText = finalOutput || streamedText;
  // Snippet for the closed card: first non-empty line, capped.
  const snippet = (() => {
    const t = responseText || '';
    if (!t) return '';
    const firstLine = t.split('\n').find(l => l.trim()) || '';
    return firstLine.length > 90 ? firstLine.slice(0, 87) + '...' : firstLine;
  })();

  return (
    <div
      className={`flow-subagent-node flow-subagent-node--${status} ${open ? 'flow-subagent-node--open' : ''}`}
      data-depth={data.depth || 1}
    >
      <Handle type="target" position={Position.Right} className="flow-handle" />
      <Handle type="source" position={Position.Right} className="flow-handle" />
      {/* Left handle: source for edges to child tool-call nodes that hang
          off this sub-agent's left side when expanded. */}
      <Handle type="source" id="children" position={Position.Left} className="flow-handle" />
      <div className="flow-subagent-node__crumb" title={`parent: ${data.parentName || ''}`}>
        parent: <span className="flow-subagent-node__crumb-name">{data.parentName || 'agent'}</span>
      </div>
      <button
        type="button"
        className="flow-subagent-node__head"
        onClick={(e) => { e.stopPropagation(); if (data.onToggle) data.onToggle(); }}
        title={data.label}
      >
        <span className="flow-subagent-node__pill">SUB-AGENT</span>
        <span className="flow-subagent-node__label">{data.label || '(unnamed)'}</span>
      </button>
      <div className="flow-subagent-node__row">
        <span className={`flow-subagent-node__status flow-subagent-node__status--${status}`}>
          {data.status || 'pending'}
        </span>
        {showDur && <span className="flow-subagent-node__dur">{showDur}</span>}
        {data.childStatus === 'loading' && (
          <span className="flow-subagent-node__childinfo" title="fetching child trace">
            loading child events...
          </span>
        )}
        {data.childStatus === 'loaded' && typeof data.childCount === 'number' && data.childCount > 0 && (
          <span className="flow-subagent-node__childinfo" title="child tool calls fetched">
            {data.childCount} child call{data.childCount === 1 ? '' : 's'}
          </span>
        )}
        {data.childStatus === 'error' && (
          <span
            className="flow-subagent-node__childinfo flow-subagent-node__childinfo--err"
            title={data.childError || 'failed to load child trace'}
          >
            child trace failed
          </span>
        )}
      </div>
      {snippet && (
        <div className="flow-subagent-node__snippet" title={responseText}>
          {snippet}
        </div>
      )}
      {open && (
        <div className="flow-subagent-node__body">
          {promptText && (
            <div className="flow-subagent-node__section">
              <div className="flow-subagent-node__section-title">prompt</div>
              <pre className="flow-subagent-node__pre">{promptText}</pre>
            </div>
          )}
          {responseText && (
            <div className="flow-subagent-node__section">
              <div className="flow-subagent-node__section-title">{isSubagentFinal ? 'final output' : 'response'}</div>
              <pre className="flow-subagent-node__pre">{responseText}</pre>
            </div>
          )}
          {isSubagentFinal && (
            <div className="flow-subagent-node__section">
              <div className="flow-subagent-node__section-title">stats</div>
              <div className="flow-subagent-node__stats">
                {typeof ro.tool_calls === 'number' && <span>{ro.tool_calls} tool call{ro.tool_calls === 1 ? '' : 's'}</span>}
                {typeof ro.turns === 'number' && <span>{ro.turns} turn{ro.turns === 1 ? '' : 's'}</span>}
                {typeof ro.duration_ms === 'number' && <span>{fmtDuration(ro.duration_ms)}</span>}
                {typeof ro.subagent_type === 'string' && <span>{ro.subagent_type}</span>}
              </div>
              {typeof ro.subagent_id === 'string' && (
                <div className="flow-subagent-node__id" title={ro.subagent_id}>
                  id: {ro.subagent_id.slice(0, 18)}...
                </div>
              )}
            </div>
          )}
          {!promptText && !responseText && (
            <div className="flow-subagent-node__section flow-subagent-node__section--empty">
              no payload yet.
            </div>
          )}
        </div>
      )}
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
  subAgent: SubAgentNode,
};

// ── helpers ───────────────────────────────────────────────────────────────

function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Lay agent cards out in a column on the left, leaving the right half of the
// canvas for tool-call satellites. React Flow handles panning + zoom.
// AGENT_TOP_OFFSET leaves room above the first row for the milestone strip.
// Each agent's row height is computed dynamically based on the height of its
// sub-agents column, tools column, and bg-task column (whichever is tallest),
// so an expanded GroupNode or ToolNode never overlaps the next agent below.
const AGENT_ROW_HEIGHT_MIN = 320;
const AGENT_TOP_OFFSET     = 110; // leave the milestone strip uncluttered
const BG_NODES_VISIBLE     = 3;

// Build the agent base positions. y is assigned at use-time by the caller
// after each cluster height is known. Returning a stub here keeps the
// per-agent .data shape intact for the rest of the pipeline.
function layoutAgents(agents) {
  return agents.map((a) => ({
    id: `agent:${a.id}`,
    type: 'agent',
    // y intentionally 0; the FlowInner useMemo pass fills it after computing
    // cluster heights.
    position: { x: 0, y: 0 },
    draggable: true,
    data: {
      agentId: a.id,
      name:    a.name || a.id.slice(0, 8),
      model:   a.model || '',
      status:  a.status || 'idle',
      // cwd lets the sub-agent direct-updates endpoint look up the child's
      // session dir without scanning. Required for the fast-path retry loop.
      cwd:     a.cwd || '',
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

// ── event dispatcher (pure) ───────────────────────────────────────────────
//
// applyAgentEventToState takes a state slot for one agent + an SSE event
// (name + payload) and returns the new slot. Pure so we can use it for both
// live SSE events (via patchAgent's updater form) and bulk history replay
// (composed in a tight loop, then committed with one setAgentState).
//
// `opts.at` is the event's wall-clock timestamp in ms (Date.parse(ev.at) for
// history, Date.now() for live). `opts.fromHistory` lets the dispatcher
// suppress live-only effects later if we ever need to.
function applyAgentEventToState(cur, name, payload, opts) {
  const at = (opts && Number.isFinite(opts.at)) ? opts.at : Date.now();

  // Token bump shared by every event that may carry _meta.totalTokens.
  const bumpTokensInto = (state, data) => {
    const t = data && data._meta && Number(data._meta.totalTokens);
    if (!Number.isFinite(t) || t <= 0) return state;
    if (t <= (state.tokens || 0)) return state; // monotone; skip duplicates
    const hist = Array.isArray(state.tokensHistory) ? state.tokensHistory.slice() : [];
    hist.push({ t: at, v: t });
    if (hist.length > TOKEN_HISTORY_MAX) hist.splice(0, hist.length - TOKEN_HISTORY_MAX);
    return { ...state, tokens: t, tokensHistory: hist, lastActivityAt: at };
  };

  switch (name) {
    case 'agent_status': {
      if (!payload) return cur;
      const status = normaliseStatus(payload.status || payload.state);
      return { ...cur, status, lastActivityAt: at };
    }

    case 'tool_call': {
      if (!payload) return cur;
      let next = bumpTokensInto(cur, payload);
      const u = (payload.update && typeof payload.update === 'object') ? payload.update : payload;
      const id = u.toolCallId || u.id || `tc-${at}-${Math.random()}`;
      const kind = (payload._meta && payload._meta.updateParams && payload._meta.updateParams.kind)
                || u.kind || '';
      const label = isSubAgentCall(u) ? pickSubAgentLabel(u) : pickToolLabel(u);
      const status = (payload._meta && payload._meta.updateParams && payload._meta.updateParams.status)
                  || u.status || 'Pending';

      if (isSubAgentCall(u)) {
        const prompt = (u.rawInput && (u.rawInput.prompt || u.rawInput.task || u.rawInput.input)) || null;
        const prevSubs = Array.isArray(next.subAgents) ? next.subAgents : [];
        const turn = (next.turn || 0) + (next._turnHasMilestone ? 0 : 1);
        const firstThisTurn = !prevSubs.some(s => s._turnSpawn === turn);
        let subAgents;
        if (prevSubs.some(s => s.id === id)) {
          subAgents = prevSubs;
        } else {
          subAgents = prevSubs.concat([{
            id,
            kind,
            label,
            parentToolCallId: id,
            status,
            prompt,
            response: [],
            toolCalls: [],
            rawInput: u.rawInput || null,
            startedAt: at,
            endedAt: null,
            _turnSpawn: turn,
          }]);
        }
        let ms = (next.milestones || []).slice();
        // Roll up sub-agent spawns into a single per-turn milestone with a
        // running count instead of one-per-child (which floods the strip
        // when an agent fan-outs to 5+ sub-agents in a single turn).
        const spawnIdx = ms.findIndex(m => m.kind === 'sub-agent-spawn' && m._turn === turn);
        if (spawnIdx < 0) {
          ms.push({
            kind: 'sub-agent-spawn',
            icon: 'S',
            label: `turn ${turn}: 1 sub-agent spawned`,
            t: at,
            _turn: turn,
            _count: 1,
          });
        } else {
          const prev = ms[spawnIdx];
          const count = (prev._count || 1) + 1;
          ms[spawnIdx] = {
            ...prev,
            label: `turn ${turn}: ${count} sub-agents spawned`,
            _count: count,
            t: prev.t, // keep the original spawn time for chronological order
          };
        }
        if (ms.length > MILESTONE_CAP) ms = ms.slice(ms.length - MILESTONE_CAP);
        next = { ...next, status: 'running', subAgents, milestones: ms, lastActivityAt: at };
        if (!next._turnHasMilestone) {
          const nTurn = (next.turn || 0) + 1;
          const ms2 = (next.milestones || []).slice();
          ms2.push({ kind: 'turn', icon: 'T', label: `turn ${nTurn}`, t: at });
          if (ms2.length > MILESTONE_CAP) ms2.splice(0, ms2.length - MILESTONE_CAP);
          next = { ...next, turn: nTurn, milestones: ms2, _turnHasMilestone: true };
        }
        return next;
      }

      const calls = { ...next.calls, [id]: {
        id,
        kind,
        label,
        status,
        rawInput: u.rawInput || null,
        rawOutput: u.rawOutput || null,
        content: extractToolContent(u.content),
        locations: Array.isArray(u.locations) ? u.locations.slice() : [],
        startedAt: at,
        endedAt: null,
      } };
      const inflight = countActive(calls);
      const peak = Math.max(next.peakInFlight || 0, inflight);
      next = { ...next, status: 'running', inFlight: inflight, peakInFlight: peak, calls, lastActivityAt: at };
      if (!next._turnHasMilestone) {
        const nTurn = (next.turn || 0) + 1;
        const ms2 = (next.milestones || []).slice();
        ms2.push({ kind: 'turn', icon: 'T', label: `turn ${nTurn}`, t: at });
        if (ms2.length > MILESTONE_CAP) ms2.splice(0, ms2.length - MILESTONE_CAP);
        next = { ...next, turn: nTurn, milestones: ms2, _turnHasMilestone: true };
      }
      return next;
    }

    case 'tool_call_update': {
      if (!payload) return cur;
      let next = bumpTokensInto(cur, payload);
      const u = (payload.update && typeof payload.update === 'object') ? payload.update : payload;
      const id = u.toolCallId || u.id;
      if (!id) return next;
      const status = (payload._meta && payload._meta.updateParams && payload._meta.updateParams.status)
                  || u.status || 'Running';
      const done = (status === 'Completed' || status === 'Failed' || status === 'canceled');

      const subs = Array.isArray(next.subAgents) ? next.subAgents : [];
      const subIdx = subs.findIndex(s => s.id === id);
      const isSubKind = isSubAgentCall(u);
      if (subIdx >= 0 || isSubKind) {
        if (subIdx < 0) {
          const prompt = (u.rawInput && (u.rawInput.prompt || u.rawInput.task || u.rawInput.input)) || null;
          const newSub = {
            id,
            kind: u.kind || '',
            label: pickSubAgentLabel(u),
            parentToolCallId: id,
            status,
            prompt,
            response: u.content ? extractToolContent(u.content) : [],
            rawOutput: u.rawOutput || null,
            toolCalls: [],
            rawInput: u.rawInput || null,
            startedAt: at,
            endedAt: done ? at : null,
            _turnSpawn: next.turn || 1,
          };
          return { ...next, subAgents: subs.concat([newSub]), lastActivityAt: at };
        }
        const prev = subs[subIdx];
        const newContent = u.content
          ? mergeToolContent(prev.response, extractToolContent(u.content))
          : prev.response;
        // Two completion regimes:
        //  - run_in_background=true: spawn_subagent fires-and-forgets, and the
        //    tool's own Completed status means "we've handed the work off."
        //    We treat that as the sub-agent's terminal state (we won't see a
        //    SubagentCompleted for these).
        //  - run_in_background=false (inline): spawn_subagent's Completed
        //    arrives with the SubagentCompleted rawOutput. We must wait for
        //    that payload before flipping to "completed", otherwise the bare
        //    Completed-ack would prematurely close the card while the child
        //    is still running.
        const ro = u.rawOutput || null;
        const isSubagentFinal = ro && ro.type === 'SubagentCompleted';
        const isHardTerminal = (status === 'Failed' || status === 'canceled');
        // Did the user request background mode? Check current rawInput (or
        // fall back to the prior copy if this update omits it).
        const effRawInput = (u.rawInput && typeof u.rawInput === 'object') ? u.rawInput : prev.rawInput;
        const isBg = !!(effRawInput && effRawInput.run_in_background);
        const reallyDone = isSubagentFinal
          || isHardTerminal
          || (status === 'Completed' && isBg);
        const effectiveStatus = (status === 'Completed' && !isSubagentFinal && !isBg && !prev.endedAt)
          ? 'Running' : status;
        let ms = (next.milestones || []).slice();
        if (reallyDone && !prev.endedAt) {
          // Roll up sub-agent completions per-turn (same approach as the
          // spawn rollup above). Failed runs get their own kind so they
          // stand out instead of being lumped with successes.
          const isFail = (status === 'Failed' || status === 'canceled');
          const turn = prev._turnSpawn || (next.turn || 1);
          const kindForRollup = isFail ? 'sub-agent-fail' : 'sub-agent-end';
          const idx = ms.findIndex(m => m.kind === kindForRollup && m._turn === turn);
          if (idx < 0) {
            ms.push({
              kind: kindForRollup,
              icon: 'S',
              label: isFail
                ? `turn ${turn}: 1 sub-agent failed`
                : `turn ${turn}: 1 sub-agent done`,
              t: at,
              _turn: turn,
              _count: 1,
            });
          } else {
            const prevMs = ms[idx];
            const count = (prevMs._count || 1) + 1;
            ms[idx] = {
              ...prevMs,
              label: isFail
                ? `turn ${turn}: ${count} sub-agents failed`
                : `turn ${turn}: ${count} sub-agents done`,
              _count: count,
              t: at,
            };
          }
          if (ms.length > MILESTONE_CAP) ms = ms.slice(ms.length - MILESTONE_CAP);
        }
        const merged = {
          ...prev,
          kind: u.kind || prev.kind,
          label: pickSubAgentLabel(u) || prev.label,
          status: effectiveStatus,
          rawInput: (u.rawInput != null) ? u.rawInput : prev.rawInput,
          rawOutput: ro || prev.rawOutput || null,
          response: newContent,
          endedAt: reallyDone ? (prev.endedAt || at) : prev.endedAt,
        };
        const nextSubs = subs.slice();
        nextSubs[subIdx] = merged;
        return { ...next, subAgents: nextSubs, milestones: ms, lastActivityAt: at };
      }

      const prev = next.calls && next.calls[id] ? next.calls[id] : {
        id,
        kind: u.kind || '',
        label: pickToolLabel(u),
        status: 'Pending',
        rawInput: null,
        rawOutput: null,
        content: [],
        locations: [],
        startedAt: at,
        endedAt: null,
      };
      const nextContent = u.content
        ? mergeToolContent(prev.content, extractToolContent(u.content))
        : prev.content;
      const merged = {
        ...prev,
        kind: u.kind || prev.kind,
        label: pickToolLabel(u) || prev.label,
        status,
        rawInput: (u.rawInput != null) ? u.rawInput : prev.rawInput,
        rawOutput: (u.rawOutput != null) ? u.rawOutput : prev.rawOutput,
        content: nextContent,
        locations: Array.isArray(u.locations) && u.locations.length ? u.locations.slice() : prev.locations,
        endedAt: done ? (prev.endedAt || at) : prev.endedAt,
      };
      const calls = { ...(next.calls || {}), [id]: merged };
      return { ...next, inFlight: countActive(calls), calls, lastActivityAt: at };
    }

    case 'agent_message_chunk': {
      if (!payload) return cur;
      let next = bumpTokensInto(cur, payload);
      next = { ...next, status: next.status === 'errored' ? next.status : 'running', lastActivityAt: at };
      return next;
    }

    case 'agent_thought_chunk': {
      if (!payload) return cur;
      return bumpTokensInto(cur, payload);
    }

    case 'user_message_chunk': {
      if (!payload) return cur;
      return { ...cur, lastUserAt: at, lastActivityAt: at };
    }

    case 'prompt_complete': {
      let next = bumpTokensInto(cur, payload || {});
      const turn = next.turn || 0;
      let ms = (next.milestones || []).slice();
      if (turn > 0) {
        ms.push({ kind: 'turn-end', icon: 'D', label: `turn ${turn} done`, t: at });
        if (ms.length > MILESTONE_CAP) ms = ms.slice(ms.length - MILESTONE_CAP);
      }
      return { ...next, status: 'idle', milestones: ms, _turnHasMilestone: false, lastActivityAt: at };
    }

    case 'task_backgrounded':
    case 'x.ai/task_backgrounded': {
      const u = (payload && payload.update) || (payload && payload.params && payload.params.update) || payload;
      if (!u) return cur;
      const cmd = u.command || u.cmd || '';
      const ms = (cur.milestones || []).slice();
      const last = ms[ms.length - 1];
      const m = { kind: 'bg-start', icon: 'U', label: `started ${truncCmd(cmd)}`, t: at };
      if (last && last.kind === m.kind && last.label === m.label && (m.t - last.t) < 1000) return cur;
      ms.push(m);
      if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
      return { ...cur, milestones: ms, lastActivityAt: at };
    }

    case 'task_completed':
    case 'x.ai/task_completed': {
      const u = (payload && payload.update) || (payload && payload.params && payload.params.update) || payload;
      if (!u) return cur;
      const snap = u.task_snapshot || {};
      const cmd = snap.command || u.command || '';
      const ms = (cur.milestones || []).slice();
      const last = ms[ms.length - 1];
      const m = { kind: 'bg-end', icon: 'V', label: `finished ${truncCmd(cmd)}`, t: at };
      if (last && last.kind === m.kind && last.label === m.label && (m.t - last.t) < 1000) return cur;
      ms.push(m);
      if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
      return { ...cur, milestones: ms, lastActivityAt: at };
    }

    default:
      return cur;
  }
}

// Build an empty state slot, hydrating tokensHistory from sessionStorage so
// the sparkline survives reloads even before replay finishes.
function freshAgentState(id) {
  const persisted = loadTokenHistory(id);
  const lastTok = persisted.length ? persisted[persisted.length - 1].v : 0;
  return {
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
  // Lifted "open" state for tool / sub-agent / bg-task cards. Keyed by the
  // node id so the parent useMemo pass can adjust the layout to make room
  // for an expanded body. Bumped via toggleNode(nodeId).
  const [expandedNodes, setExpandedNodes] = useState(() => new Set());
  // Positions overwritten by the user dragging nodes. Cleared by the
  // "reset layout" toolbar button. The useMemo layout pass keeps any node
  // id present in this map at its dragged x/y; auto-layout wins for
  // everything else.
  const [userPositions, setUserPositions] = useState({}); // nodeId -> {x, y}
  const [statsOpen, setStatsOpen]         = useState(hasFilter); // open by default in scoped view
  const [tick, setTick]                   = useState(0); // forces re-render of live durations
  // Per-sub-agent child trace state. Keyed by `${agentId}:${subId}`. Value is
  // { status: 'loading'|'loaded'|'error', calls: [...], error?: string,
  //   fetchedAt: number, sessionId: string }. Lazy-populated on first
  // sub-agent expand; cached until the user hits the per-card refresh
  // button (not yet wired) or reloads the page.
  const [subagentChildren, setSubagentChildren] = useState({});
  const { fitView } = useReactFlow();

  // Mutable refs that survive re-renders without re-subscribing effects.
  const streamsRef    = useRef(new Map()); // id -> EventSource
  const replayedRef   = useRef(new Set()); // agent ids whose history we already replayed
  const pollTimerRef  = useRef(null);
  const bgPollTimerRef = useRef(null);
  // Stash latest expandedNodes so the post-toggle fitView effect can read
  // the "size change" signal without re-running on every other piece of
  // state. Updated in toggleNode.
  const expandFitTimerRef = useRef(null);
  // Keys of sub-agent child fetches currently in flight. Prevents a second
  // request from being kicked off while the first hasn't resolved (e.g.
  // user rapidly toggling the same sub-agent open/closed/open).
  const subChildInFlightRef = useRef(new Set());
  // Per-key retry state for sub-agent child fetches. We use staged backoff
  // when the session dir hasn't been flushed yet, then once the sub-agent
  // is marked done we do the final retries and stop.
  //   key -> { attempts, sessionId, cwd, timer, stopped }
  const subChildRetryRef = useRef(new Map());
  // Latest agentState mirror so polling retry callbacks can decide whether
  // the sub-agent is still running (keep retrying every 5s) or done (a few
  // final retries then give up).
  const agentStateRef = useRef({});
  useEffect(() => { agentStateRef.current = agentState; }, [agentState]);

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
      const cur = prev[id] || freshAgentState(id);
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      // Persist when history grew. Cheap; runs at most ~2/sec per agent.
      if (next.tokensHistory && next.tokensHistory !== cur.tokensHistory) {
        saveTokenHistory(id, next.tokensHistory);
      }
      return { ...prev, [id]: next };
    });
  }, []);

  // ── SSE wiring ─────────────────────────────────────────────────────────

  // Live event dispatcher. Routes one SSE event through the same pure
  // state-mutation helper that history replay uses, so live and replay
  // paths can never diverge.
  const applyAgentEvent = useCallback((agent, name, payload, opts) => {
    patchAgent(agent.id, (cur) => applyAgentEventToState(cur, name, payload, opts || {}));
  }, [patchAgent]);

  // Walks history.jsonl events for an agent, applying each through the same
  // pure dispatcher live events use. Batched into a single setAgentState so
  // React only re-renders once per replay (vs ~thousands of patchAgent calls).
  const replayHistoryFor = useCallback(async (agent) => {
    if (!agent || !agent.id) return;
    if (replayedRef.current.has(agent.id)) return;
    replayedRef.current.add(agent.id);
    let hist;
    try {
      hist = await api.history(agent.id, { all: true });
    } catch {
      // Server error or 404. Allow a future retry by clearing the marker.
      replayedRef.current.delete(agent.id);
      return;
    }
    const events = Array.isArray(hist && hist.events) ? hist.events : [];
    if (!events.length) {
      // Still mark replayed so we don't refetch on every effect tick.
      patchAgent(agent.id, (cur) => ({ ...cur, _replayed: true }));
      return;
    }
    const slice = events.length > HISTORY_REPLAY_MAX
      ? events.slice(events.length - HISTORY_REPLAY_MAX)
      : events;
    setAgentState((prev) => {
      let cur = prev[agent.id] || freshAgentState(agent.id);
      for (const ev of slice) {
        if (!ev || typeof ev !== 'object') continue;
        const at = ev.at ? Date.parse(ev.at) : NaN;
        cur = applyAgentEventToState(cur, ev.event, ev.data, {
          fromHistory: true,
          at: Number.isFinite(at) ? at : Date.now(),
        });
      }
      cur = { ...cur, _replayed: true };
      if (cur.tokensHistory) saveTokenHistory(agent.id, cur.tokensHistory);
      return { ...prev, [agent.id]: cur };
    });
  }, [patchAgent]);

  const openStreamFor = useCallback((agent) => {
    if (streamsRef.current.has(agent.id)) return;
    // Kick off history replay first. Don't await; SSE can open in parallel
    // and any overlap dedups naturally through toolCallId merges + monotone
    // token bumps.
    replayHistoryFor(agent);

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

    const live = (name) => (ev) => {
      const data = safeParse(ev.data);
      if (data == null && name !== 'prompt_complete') return;
      applyAgentEvent(agent, name, data, {});
    };

    es.addEventListener('agent_status', live('agent_status'));
    es.addEventListener('tool_call', live('tool_call'));
    es.addEventListener('tool_call_update', live('tool_call_update'));
    es.addEventListener('agent_message_chunk', live('agent_message_chunk'));
    es.addEventListener('agent_thought_chunk', live('agent_thought_chunk'));
    es.addEventListener('user_message_chunk', live('user_message_chunk'));
    es.addEventListener('prompt_complete', live('prompt_complete'));
    es.addEventListener('task_backgrounded', live('task_backgrounded'));
    es.addEventListener('x.ai/task_backgrounded', live('x.ai/task_backgrounded'));
    es.addEventListener('task_completed', live('task_completed'));
    es.addEventListener('x.ai/task_completed', live('x.ai/task_completed'));

    es.addEventListener('error', () => {
      // EventSource will reconnect on its own; flag the card meanwhile so
      // the user sees something is off.
      patchAgent(agent.id, (cur) => ({ ...cur, status: cur.status === 'running' ? 'errored' : cur.status }));
    });
  }, [patchAgent, applyAgentEvent, replayHistoryFor]);

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
    // Defer a small fit so the newly-revealed children stay on screen.
    if (expandFitTimerRef.current) cancelAnimationFrame(expandFitTimerRef.current);
    expandFitTimerRef.current = requestAnimationFrame(() => {
      try { fitView({ padding: 0.15, duration: 250 }); } catch { /* ignore */ }
    });
  }, [fitView]);

  // Kick off a child-trace fetch for one sub-agent. Tries the fast direct
  // updates.jsonl endpoint first, falls back to grok-trace, and retries on
  // a staged backoff if both fail (likely cause: session dir hasn't been
  // flushed to disk yet, common for brand-new bg sub-agents).
  //
  // While the sub-agent is still running we keep retrying every
  // SUB_CHILD_LIVE_RETRY_MS ms forever. Once it ends we do up to
  // SUB_CHILD_RETRY_DELAYS_MS.length attempts on backoff, then give up.
  //
  // key: `${agentId}:${subId}` (also matches the layout pass's childKey).
  // sessionId: the sub-agent's grok session id (UUID).
  // cwd: the parent agent's cwd; threaded so the direct endpoint can find
  //      the session dir without scanning.
  const fetchSubChildren = useCallback((key, sessionId, cwd) => {
    if (!sessionId) return;
    if (subChildInFlightRef.current.has(key)) return;

    // Tracks per-key retry state. Created on first call, mutated in place
    // so timers can read live values without re-running the effect.
    let st = subChildRetryRef.current.get(key);
    if (!st) {
      st = { attempts: 0, sessionId, cwd: cwd || '', timer: null, stopped: false };
      subChildRetryRef.current.set(key, st);
    } else {
      st.sessionId = sessionId;
      if (cwd) st.cwd = cwd;
      st.stopped = false;
    }

    setSubagentChildren((prev) => {
      const existing = prev[key];
      if (existing && existing.status === 'loaded' && existing.calls.length > 0) {
        return prev;
      }
      return { ...prev, [key]: { status: 'loading', calls: [], sessionId } };
    });
    subChildInFlightRef.current.add(key);

    // Direct-first fetch. Returns { calls, source } on success or throws.
    const fetchOnce = async () => {
      // 1. Direct read of updates.jsonl. Cheap; works while live.
      try {
        const direct = await api.subagents.updates(sessionId, st.cwd);
        if (direct && Array.isArray(direct.updates)) {
          const calls = extractChildCallsFromTrace({ updates: direct.updates });
          if (calls.length > 0) return { calls, source: 'direct' };
          // Empty: keep going to the trace fallback, then to retries.
        }
      } catch { /* fall through */ }
      // 2. Trace fallback. Slower but is the only path that works once the
      //    session dir has been compacted / cleaned up.
      const data = await api.subagents.trace(sessionId);
      const calls = extractChildCallsFromTrace(data);
      return { calls, source: 'trace' };
    };

    const isStillRunning = () => {
      const [agentId, subId] = key.split(':');
      const slot = agentStateRef.current[agentId];
      if (!slot || !Array.isArray(slot.subAgents)) return false;
      const sub = slot.subAgents.find(s => s.id === subId);
      if (!sub) return false;
      const status = String(sub.status || '').toLowerCase();
      return !sub.endedAt && (status === 'pending' || status === 'running' || status === 'in_progress');
    };

    const scheduleRetry = (errMsg) => {
      st.attempts += 1;
      // While the sub is live, retry forever on the live cadence.
      // Once it ends, retry on staged backoff, then give up.
      const live = isStillRunning();
      let delay;
      if (live) {
        delay = SUB_CHILD_LIVE_RETRY_MS;
      } else if (st.attempts <= SUB_CHILD_RETRY_DELAYS_MS.length) {
        delay = SUB_CHILD_RETRY_DELAYS_MS[st.attempts - 1];
      } else {
        // Gave up. Surface the error.
        setSubagentChildren((prev) => ({
          ...prev,
          [key]: {
            status: 'error',
            calls: (prev[key] && prev[key].calls) || [],
            sessionId,
            error: errMsg || 'fetch failed',
            fetchedAt: Date.now(),
          },
        }));
        st.stopped = true;
        return;
      }
      // Keep the spinner up so the user sees we're still working.
      setSubagentChildren((prev) => ({
        ...prev,
        [key]: {
          status: 'loading',
          calls: (prev[key] && prev[key].calls) || [],
          sessionId,
          retryAttempt: st.attempts,
          retryReason: errMsg || null,
        },
      }));
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        st.timer = null;
        if (st.stopped) return;
        if (subChildInFlightRef.current.has(key)) return;
        subChildInFlightRef.current.add(key);
        run();
      }, delay);
    };

    const run = () => {
      fetchOnce().then(({ calls, source }) => {
        if (calls.length === 0) {
          // Nothing yet. If the sub is still running, retry; otherwise the
          // child genuinely had zero tool calls, which is a valid loaded
          // state.
          if (isStillRunning()) {
            subChildInFlightRef.current.delete(key);
            scheduleRetry('no events yet');
            return;
          }
          setSubagentChildren((prev) => ({
            ...prev,
            [key]: { status: 'loaded', calls: [], sessionId, fetchedAt: Date.now(), source },
          }));
          st.stopped = true;
          subChildInFlightRef.current.delete(key);
          return;
        }
        setSubagentChildren((prev) => ({
          ...prev,
          [key]: { status: 'loaded', calls, sessionId, fetchedAt: Date.now(), source },
        }));
        st.attempts = 0;
        st.stopped = true;
        subChildInFlightRef.current.delete(key);
      }).catch((err) => {
        const msg = (err && err.message) || 'fetch failed';
        subChildInFlightRef.current.delete(key);
        scheduleRetry(msg);
      });
    };

    run();
  }, []);

  // Clean up any pending retry timers on unmount so we don't leak intervals.
  useEffect(() => {
    const map = subChildRetryRef.current;
    return () => {
      for (const st of map.values()) {
        if (st.timer) clearTimeout(st.timer);
        st.stopped = true;
      }
      map.clear();
    };
  }, []);

  // Lifted "open/closed" toggle for the rest of the expandable node types
  // (tool, sub-agent). The parent re-renders, the layout reflows around
  // the newly-tall body, and we fit-view so the user can see it.
  //
  // For sub-agent nodes, opening also kicks off a one-time fetch of the
  // child agent's trace (its own session's tool calls live there).
  const toggleNode = useCallback((nodeId, ctx) => {
    let wasOpen = false;
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) { next.delete(nodeId); wasOpen = true; }
      else next.add(nodeId);
      return next;
    });
    // ctx: { kind: 'subAgent', childKey, sessionId, cwd } -- if present and
    // we just opened the node, lazy-load the child trace.
    if (!wasOpen && ctx && ctx.kind === 'subAgent' && ctx.childKey && ctx.sessionId) {
      fetchSubChildren(ctx.childKey, ctx.sessionId, ctx.cwd || '');
    }
    if (expandFitTimerRef.current) cancelAnimationFrame(expandFitTimerRef.current);
    expandFitTimerRef.current = requestAnimationFrame(() => {
      try { fitView({ padding: 0.15, duration: 250 }); } catch { /* ignore */ }
    });
  }, [fitView, fetchSubChildren]);

  // User dragged a node. Remember the new x/y so the next auto-layout pass
  // leaves it where the user dropped it.
  const onNodeDragStop = useCallback((_ev, node) => {
    if (!node || !node.id) return;
    setUserPositions((prev) => ({ ...prev, [node.id]: { x: node.position.x, y: node.position.y } }));
  }, []);

  // Reset every user-overridden position back to the auto-computed layout
  // and re-fit. Used by the "reset layout" toolbar button.
  const resetLayout = useCallback(() => {
    setUserPositions({});
    if (expandFitTimerRef.current) cancelAnimationFrame(expandFitTimerRef.current);
    expandFitTimerRef.current = requestAnimationFrame(() => {
      try { fitView({ padding: 0.2, duration: 300 }); } catch { /* ignore */ }
    });
  }, [fitView]);

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
          depth: 0,
        },
      };
    });

    const auxNodes = [];
    const auxEdges = [];

    // Running y-cursor for the agent column. We compute each agent's y at the
    // top of the loop, then advance the cursor past the tallest of its three
    // child columns (sub-agents, tools, bg-tasks). This guarantees the next
    // agent never overlaps an expanded tool body in the row above.
    let agentY = AGENT_TOP_OFFSET;

    agentNodes.forEach((agentNode) => {
      // Anchor the agent at the current cursor position.
      agentNode.position = { x: 0, y: agentY };
      const baseY = agentY;
      const st = agentState[agentNode.data.agentId];

      // Pre-compute each column's running height. Each column maintains a
      // local cursor (in canvas y), starting at the agent's baseY. We add
      // node + GAP, never a fixed row pitch, so an expanded body actually
      // displaces its siblings.
      let subY  = baseY;
      let toolY = baseY;
      let bgY   = baseY + 120; // bg starts below the agent card itself

      if (st) {
        // --- Sub-agents (hang off the LEFT of the parent) ---
        if (Array.isArray(st.subAgents) && st.subAgents.length) {
          const subs = st.subAgents
            .slice()
            .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
          subs.forEach((sub) => {
            const subId = `sub:${agentNode.data.agentId}:${sub.id}`;
            const isOpen = expandedNodes.has(subId);
            const sx = agentNode.position.x + LAYOUT.SUB_AGENT_X;
            const sy = subY;
            const status = String(sub.status || 'pending').toLowerCase();
            const running = !sub.endedAt && (status === 'pending' || status === 'running' || status === 'in_progress');
            // Child-trace state lookup. We don't fetch here (that happens
            // in toggleNode on open) -- this is only for the data we pass
            // into the SubAgentNode for its loading badge + the children
            // we render off to the left when expanded.
            const childKey = `${agentNode.data.agentId}:${sub.id}`;
            const childEntry = subagentChildren[childKey];
            const childSessionId = extractSubagentId(sub);
            auxNodes.push({
              id: subId,
              type: 'subAgent',
              position: { x: sx, y: sy },
              draggable: true,
              selectable: true,
              data: {
                id: sub.id,
                label: sub.label,
                kind: sub.kind,
                status: sub.status,
                prompt: sub.prompt,
                response: sub.response,
                rawOutput: sub.rawOutput || null,
                startedAt: sub.startedAt,
                endedAt: sub.endedAt,
                parentName: agentNode.data.name,
                depth: 1,
                isOpen,
                childStatus: childEntry ? childEntry.status : (childSessionId ? 'idle' : null),
                childCount: childEntry && Array.isArray(childEntry.calls) ? childEntry.calls.length : 0,
                childError: childEntry && childEntry.error ? childEntry.error : null,
                onToggle: () => toggleNode(subId, {
                  kind: 'subAgent',
                  childKey,
                  sessionId: childSessionId,
                  cwd: agentNode.data.cwd || '',
                }),
              },
            });
            auxEdges.push({
              id: `edge:${agentNode.id}->${subId}`,
              source: agentNode.id,
              sourceHandle: 'sub',
              target: subId,
              animated: running,
              style: {
                stroke: status === 'failed'
                  ? 'var(--red)'
                  : (running ? 'var(--blue)' : 'var(--dim)'),
                strokeWidth: 1.4,
                opacity: running ? 1 : 0.7,
                strokeDasharray: running ? '0' : '4 3',
              },
            });
            // The sub-agent card's own height contribution.
            subY += nodeKind('subAgent', isOpen) + LAYOUT.SUB_AGENT_GAP;

            // --- Child tool calls (rendered LEFT of the sub-agent card) ---
            // Only when:
            //   - the sub-agent is expanded
            //   - we successfully fetched a non-empty trace
            // We position child nodes vertically aligned with the
            // sub-agent's top, in their own short column, then advance
            // subY past whichever column is taller (the sub-agent itself
            // or its child column).
            if (isOpen && childEntry && childEntry.status === 'loaded' && childEntry.calls.length > 0) {
              const childX = sx + LAYOUT.SUB_AGENT_CHILD_X;
              let childY = sy;
              childEntry.calls.forEach((call) => {
                const childId = `subtool:${agentNode.data.agentId}:${sub.id}:${call.id}`;
                const childOpen = expandedNodes.has(childId);
                const inactive = !!call.endedAt;
                auxNodes.push({
                  id: childId,
                  type: 'tool',
                  position: { x: childX, y: childY },
                  draggable: true,
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
                    isOpen: childOpen,
                    onToggle: () => toggleNode(childId),
                    depth: 2,
                  },
                  style: inactive ? { opacity: 0.85 } : { opacity: 1 },
                  className: 'flow-tool-node-wrap flow-tool-node-wrap--subchild',
                });
                auxEdges.push({
                  id: `edge:${subId}->${childId}`,
                  source: subId,
                  sourceHandle: 'children',
                  target: childId,
                  animated: !call.endedAt,
                  style: {
                    stroke: (String(call.status || '').toLowerCase() === 'failed' ? 'var(--red)' : 'var(--blue)'),
                    strokeWidth: 1.1,
                    opacity: call.endedAt ? 0.6 : 1,
                  },
                });
                childY += nodeKind('tool', childOpen) + LAYOUT.SUB_AGENT_CHILD_GAP;
              });
              // Advance the parent subY cursor past the bottom of the
              // child column if it ended below the sub-agent card itself.
              if (childY > subY) {
                subY = childY + LAYOUT.SUB_AGENT_GAP;
              }
            }
          });
        }

        // --- Tool calls + grouping (single column on the right) ---
        if (st.calls && Object.keys(st.calls).length) {
          const sortedCalls = Object.values(st.calls).slice().sort((a, b) => {
            const at = a.startedAt || 0, bt = b.startedAt || 0;
            return at - bt;
          });
          const items = groupToolCalls(sortedCalls);
          const TOOL_X = 320;
          items.forEach((entry) => {
            if (entry.type === 'group') {
              const groupKey = `${entry.kind}@${entry.startedAt}`;
              const expanded = !!expandedGroups[`${agentNode.data.agentId}:${groupKey}`];
              const nodeId = `group:${agentNode.data.agentId}:${groupKey}`;
              const gx = TOOL_X;
              const gy = toolY;
              auxNodes.push({
                id: nodeId,
                type: 'group',
                position: { x: gx, y: gy },
                draggable: true,
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
              // Advance past the group header itself.
              toolY = gy + nodeKind('group', false);
              if (expanded) {
                // Stack expanded children below the group node, tallying the
                // running cursor so subsequent tools/groups push down.
                let childY = toolY + 6;
                entry.items.forEach((call) => {
                  const childId = `tool:${agentNode.data.agentId}:${call.id}`;
                  const childOpen = expandedNodes.has(childId);
                  const childX = gx;
                  const inactive = !!call.endedAt;
                  auxNodes.push({
                    id: childId,
                    type: 'tool',
                    position: { x: childX, y: childY },
                    draggable: true,
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
                      isOpen: childOpen,
                      onToggle: () => toggleNode(childId),
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
                  childY += (childOpen ? GROUP_CHILD_ROW_OPEN : GROUP_CHILD_ROW) + 4;
                });
                toolY = childY;
              }
              toolY += LAYOUT.TOOL_GAP;
            } else {
              const call = entry.call;
              const nodeId = `tool:${agentNode.data.agentId}:${call.id}`;
              const isOpen = expandedNodes.has(nodeId);
              const inactive = !!call.endedAt;
              auxNodes.push({
                id: nodeId,
                type: 'tool',
                position: { x: TOOL_X, y: toolY },
                draggable: true,
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
                  isOpen,
                  onToggle: () => toggleNode(nodeId),
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
              toolY += nodeKind('tool', isOpen) + LAYOUT.TOOL_GAP;
            }
          });
        }

        // --- Background-task nodes (stacked below the agent) ---
        if (Array.isArray(st.bgTerminals) && st.bgTerminals.length) {
          // Show running first, then a few most-recent exited.
          const running = st.bgTerminals.filter(t => !t.exited);
          const exited  = st.bgTerminals.filter(t => t.exited);
          const visible = running.concat(exited).slice(0, BG_NODES_VISIBLE);
          visible.forEach((t) => {
            const bgId = `bg:${agentNode.data.agentId}:${t.id}`;
            auxNodes.push({
              id: bgId,
              type: 'bgTask',
              position: { x: agentNode.position.x, y: bgY },
              draggable: true,
              selectable: true,
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
            bgY += nodeKind('bgTask', false) + LAYOUT.BG_GAP;
          });
        }

        // --- Milestone strip (top of canvas) per-agent ---
        // In scoped mode we show a single strip at canvas top. In global mode
        // each agent's strip sits just above its row so multiple conversations
        // don't fight for the same X scale.
        //
        // We used to scale x by timestamp, but that wedged closely-spaced
        // events on top of each other and shoved the latest event to the
        // far-right edge regardless of how isolated it was. Now we just sort
        // chronologically and place left-to-right with a fixed step, plus a
        // 2-row y-stagger so neighbours never collide.
        if (Array.isArray(st.milestones) && st.milestones.length) {
          const strip = st.milestones
            .slice(-MILESTONE_CAP)
            .slice()
            .sort((a, b) => (a.t || 0) - (b.t || 0));
          const MS_STEP_X   = MILESTONE_STEP_X;
          const MS_ROW_DY   = MILESTONE_ROW_DY;
          const stripBaseY  = agents.length === 1
            ? 8
            : (agentNode.position.y - 56);
          strip.forEach((m, j) => {
            const x = j * MS_STEP_X;
            const y = stripBaseY + ((j % 2) * MS_ROW_DY);
            auxNodes.push({
              id: `ms:${agentNode.data.agentId}:${j}:${m.t}:${m.kind}`,
              type: 'milestone',
              position: { x, y },
              draggable: false,
              selectable: false,
              data: m,
            });
          });
        }
      }

      // Cluster height = whichever column extends the furthest. Floor it at
      // AGENT_ROW_HEIGHT_MIN so a barely-active agent still gets vertical
      // breathing room.
      const clusterBottom = Math.max(subY, toolY, bgY, baseY + NODE_HEIGHTS.agent.closed);
      const clusterHeight = Math.max(AGENT_ROW_HEIGHT_MIN, clusterBottom - baseY);
      agentY = baseY + clusterHeight + LAYOUT.AGENT_CLUSTER_GAP;
    });

    // Apply any user-dragged overrides last. The auto-layout pass is the
    // source of truth for everything else; user drags only override the
    // single node they dragged.
    const allNodes = [...agentNodes, ...auxNodes];
    for (const n of allNodes) {
      const pos = userPositions[n.id];
      if (pos) n.position = pos;
    }

    return { nodes: allNodes, edges: auxEdges };
  }, [agents, agentState, hasFilter, showAll, filterIds, expandedGroups, expandedNodes, userPositions, toggleGroup, toggleNode, tick, subagentChildren]);

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
          className="flow-toolbar__btn"
          onClick={resetLayout}
          title="snap every node back to the auto-computed position"
          disabled={Object.keys(userPositions).length === 0}
        >reset layout</button>
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
              onNodeDragStop={onNodeDragStop}
              nodesDraggable
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
                subagentChildren={subagentChildren}
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
// Cap kept generous so the sparkline / stats chart can show a meaningful
// history curve after replaying ~5000 events on page reload.
const TOKEN_HISTORY_MAX = 200;
// Cap on how many history events we replay on first open. Keeps reload
// time low for very long sessions while still covering all realistic cases.
const HISTORY_REPLAY_MAX = 5000;

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
function FlowStatsPanel({ agents, agentState, subagentChildren, onClose, tick }) {
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
    const subAgentEntries = []; // flat list across all visible agents
    let subAgentTotalMs = 0;
    let subAgentTimed = 0;

    for (const a of agents) {
      const st = agentState[a.id] || {};
      if (Array.isArray(st.subAgents)) {
        for (const sa of st.subAgents) {
          subAgentEntries.push({ ...sa, parentName: a.name || a.id.slice(0, 8) });
          if (sa.startedAt && sa.endedAt) {
            subAgentTotalMs += Math.max(0, sa.endedAt - sa.startedAt);
            subAgentTimed += 1;
          }
        }
      }
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

    subAgentEntries.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const lastSubAgent = subAgentEntries.length ? subAgentEntries[subAgentEntries.length - 1] : null;
    const subAgentAvgMs = subAgentTimed ? Math.round(subAgentTotalMs / subAgentTimed) : 0;

    // Total fetched child tool calls across all loaded sub-agents. Only
    // sub-agents the user has expanded contribute (their child trace was
    // lazy-fetched on expand); collapsed ones report 0 here.
    let subAgentChildCallTotal = 0;
    if (subagentChildren && typeof subagentChildren === 'object') {
      for (const v of Object.values(subagentChildren)) {
        if (v && v.status === 'loaded' && Array.isArray(v.calls)) {
          subAgentChildCallTotal += v.calls.length;
        }
      }
    }

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
      subAgentCount: subAgentEntries.length,
      subAgentAvgMs,
      subAgentChildCallTotal,
      lastSubAgent,
    };
  }, [agents, agentState, subagentChildren]);

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

      <section className="flow-stats__section">
        <div className="flow-stats__section-title">sub-agents</div>
        {stats.subAgentCount > 0 ? (
          <>
            <div className="flow-stats__row">
              <span className="flow-stats__row-key">spawned</span>
              <span className="flow-stats__row-val">{stats.subAgentCount}</span>
            </div>
            <div className="flow-stats__row">
              <span className="flow-stats__row-key">avg time</span>
              <span className="flow-stats__row-val">{stats.subAgentAvgMs ? fmtDuration(stats.subAgentAvgMs) : '--'}</span>
            </div>
            <div className="flow-stats__row" title="sum of tool calls inside expanded sub-agents (fetched on demand)">
              <span className="flow-stats__row-key">total child calls</span>
              <span className="flow-stats__row-val">{stats.subAgentChildCallTotal || 0}</span>
            </div>
            {stats.lastSubAgent && (
              <div className="flow-stats__row">
                <span className="flow-stats__row-key">most recent</span>
                <span
                  className="flow-stats__row-val flow-stats__row-val--blue"
                  title={stats.lastSubAgent.label || ''}
                >
                  {truncCmd(stats.lastSubAgent.label || '(unnamed)')}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="flow-stats__empty">none yet.</div>
        )}
      </section>

      <section className="flow-stats__section flow-stats__section--counters">
        <Counter label="tool calls" value={stats.totalCalls} />
        <Counter label="turns"      value={stats.totalTurns} />
        <Counter label="sub-agents" value={stats.subAgentCount} />
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
