// Floating-edge support for the live agent Flow canvas.
//
// React Flow's default edges anchor to a fixed Handle on each node, so when
// dagre lays nodes out in arbitrary positions an edge will often crawl across
// the body of its target to reach the chosen handle. The "floating edge"
// pattern (recommended in the React Flow docs at
// https://reactflow.dev/examples/edges/floating-edges) instead computes the
// edge endpoint as the closest intersection point on each node's bounding
// rectangle every render, so the edge always touches the nearest side.
//
// We implement two pieces here:
//
//   1. `getEdgeParams(source, target)` -- given two InternalNode objects from
//      React Flow's store, returns { sx, sy, tx, ty }: the coordinates where
//      a straight line between the two node centers crosses each node's
//      bounding rectangle. Hand-rolled rectangle-line intersection: project
//      the center-to-center delta to whichever edge (left/right/top/bottom)
//      it crosses first. No external library.
//
//   2. `FloatingEdge` -- a React Flow custom edge component. Reads the source
//      and target InternalNode via `useInternalNode`, computes the path
//      endpoints, and renders a <BaseEdge> with a straight path. Stroke
//      colour comes from `data.color` on the edge (set by the layout pass in
//      flow.jsx) so the existing teal-for-active / dim-for-done / red-for-
//      failed scheme keeps working.

import React from 'react';
import { BaseEdge, useInternalNode, getStraightPath } from '@xyflow/react';

// Centerpoint of a node in absolute canvas coordinates. Falls back to the
// node's `position` field if `positionAbsolute` hasn't been measured yet
// (first render before React Flow lays out).
function nodeCenter(node) {
  const w = (node.measured && node.measured.width)  || node.width  || 0;
  const h = (node.measured && node.measured.height) || node.height || 0;
  const pos = (node.internals && node.internals.positionAbsolute) || node.position || { x: 0, y: 0 };
  return { x: pos.x + w / 2, y: pos.y + h / 2 };
}

// Where does a line from `otherCenter` to `node`'s center cross `node`'s
// bounding rectangle? Returns absolute (x, y) coordinates. Uses the
// parametric form: walk from the node center toward the other center, scaled
// by the largest t such that we're still inside the rectangle. That t lands
// us exactly on one of the four edges.
//
// Math: the line through the center (cx, cy) with direction (dx, dy) hits
// the rectangle at t = min(hw/|dx|, hh/|dy|) where hw = w/2, hh = h/2. The
// intersection point is (cx + t * dx, cy + t * dy). When both dx and dy are
// non-zero we pick whichever axis the ray hits first (the smaller t).
function getIntersectionPoint(node, otherCenter) {
  const w = (node.measured && node.measured.width)  || node.width  || 1;
  const h = (node.measured && node.measured.height) || node.height || 1;
  const pos = (node.internals && node.internals.positionAbsolute) || node.position || { x: 0, y: 0 };
  const cx = pos.x + w / 2;
  const cy = pos.y + h / 2;
  const dx = otherCenter.x - cx;
  const dy = otherCenter.y - cy;

  // Degenerate: centers coincide. Return the center itself.
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const hw = w / 2;
  const hh = h / 2;

  // t is how far we can walk from the center along (dx, dy) before exiting
  // the rectangle. Whichever axis bounds us first wins.
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);

  return { x: cx + dx * t, y: cy + dy * t };
}

// Public helper: compute endpoint params for an edge connecting `source` to
// `target`. Each endpoint is clamped to the corresponding node's bounding
// rectangle so the line never overlaps the node body.
export function getEdgeParams(source, target) {
  const sc = nodeCenter(source);
  const tc = nodeCenter(target);
  const sIntersect = getIntersectionPoint(source, tc);
  const tIntersect = getIntersectionPoint(target, sc);
  return {
    sx: sIntersect.x,
    sy: sIntersect.y,
    tx: tIntersect.x,
    ty: tIntersect.y,
  };
}

// Custom edge component. React Flow re-renders this whenever its source or
// target node moves (the `useInternalNode` subscription handles that), so
// the path stays glued to the closest rectangle side as the user drags.
export function FloatingEdge({
  id,
  source,
  target,
  markerEnd,
  markerStart,
  style,
  data,
  animated,
  selected,
}) {
  void animated;
  void selected;
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!sourceNode || !targetNode) return null;

  const { sx, sy, tx, ty } = getEdgeParams(sourceNode, targetNode);
  const [edgePath] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty });

  // Pull stroke from data.color (set by the layout pass) when present; fall
  // back to whatever the existing `style` object specifies (legacy edges).
  const color  = (data && data.color)       || (style && style.stroke)         || 'var(--teal)';
  const width  = (data && data.strokeWidth) || (style && style.strokeWidth)    || 1.2;
  const op     = (style && style.opacity)   != null ? style.opacity            : 1;
  const dash   = (style && style.strokeDasharray) || (data && data.strokeDasharray) || undefined;

  const mergedStyle = {
    ...(style || {}),
    stroke: color,
    strokeWidth: width,
    opacity: op,
    strokeDasharray: dash,
  };

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      style={mergedStyle}
    />
  );
}

export default FloatingEdge;
