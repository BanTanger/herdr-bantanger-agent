// The graph as data: cards in columns by what blocks them, so the frontier reads left to
// right. No Herdr imports. Coordinates are world coordinates on an endless canvas.

export const LIVE_MS = 60000;

export const kids = (b, id) => (b.plan ?? []).filter((n) => n.parent === id);
export const touched = (p, now) => Boolean(p.touchedAt && now - p.touchedAt < LIVE_MS);
export const compLive = (b, p, now) => p.status === "active" || touched(p, now);
export const isUnfolded = (b, p, ui, now) => !ui.closed.has(p.id) && (ui.open.has(p.id) || compLive(b, p, now));

// A ticket's own rows: its checklist tasks, else the lines of its question or answer.
const rowCount = (b, p) => kids(b, p.id).length + (p.rows?.length ?? 0);

export function detailHeight(b, p) {
  const n = rowCount(b, p);
  return n ? n * 45 + 4 : 64;
}

export function nodeMetrics(b, p, ui, now) {
  const nodeW = 400;
  const nodeH = 128;
  if (!isUnfolded(b, p, ui, now)) return { w: nodeW, h: nodeH, nodeW, nodeH, detailW: 0, detailH: 0 };
  const detailH = detailHeight(b, p);
  return { w: 400, h: nodeH + 24 + detailH, nodeW, nodeH, detailW: 400, detailH };
}

export function boardLayout(b, ui, now) {
  const phases = b.plan.filter((n) => n.level === "component");
  const byId = Object.fromEntries(phases.map((p) => [p.id, p]));
  const depth = {};
  const visiting = new Set();
  const getDepth = (p) => {
    if (depth[p.id] != null) return depth[p.id];
    if (visiting.has(p.id)) return 0;
    visiting.add(p.id);
    const preds = (p.needs ?? []).filter((id) => byId[id]);
    depth[p.id] = preds.length ? 1 + Math.max(...preds.map((id) => getDepth(byId[id]))) : 0;
    visiting.delete(p.id);
    return depth[p.id];
  };
  phases.forEach(getDepth);
  const cols = {};
  phases.forEach((p) => (cols[depth[p.id]] ??= []).push(p));
  const gx = 120, gy = 48, pad = 64;
  const metrics = Object.fromEntries(phases.map((p) => [p.id, nodeMetrics(b, p, ui, now)]));
  const columnWidths = {};
  for (const [col, list] of Object.entries(cols)) columnWidths[col] = Math.max(...list.map((p) => metrics[p.id].w));
  const columnX = {};
  let nextX = pad;
  for (const col of Object.keys(cols).map(Number).sort((a, c) => a - c)) {
    columnX[col] = nextX;
    nextX += columnWidths[col] + gx;
  }
  const pos = {};
  let maxBottom = pad;
  for (const [col, list] of Object.entries(cols)) {
    let nextY = pad;
    for (const p of list) {
      const size = metrics[p.id];
      const x = columnX[col] + (columnWidths[col] - size.w) / 2;
      pos[p.id] = { x, y: nextY, ...size, nodeX: x + (size.w - size.nodeW) / 2, nodeY: nextY };
      nextY += size.h + gy;
    }
    maxBottom = Math.max(maxBottom, nextY - gy + pad);
  }
  return { phases, byId, pos, width: Math.max(nextX - gx + pad, 560), height: Math.max(maxBottom, 300) };
}

const curveH = (x1, y1, x2, y2, bend) => ({ x1, y1, ax: x1 + bend, ay: y1, bx: x2 - bend, by: y2, x2, y2 });

function needEdge(source, target, pos) {
  const a = pos[source.id], c = pos[target.id];
  const x1 = a.nodeX + a.nodeW, y1 = a.nodeY + a.nodeH / 2, x2 = c.nodeX, y2 = c.nodeY + c.nodeH / 2;
  const live = source.status === "active" || target.status === "active";
  const curve = curveH(x1, y1, x2, y2, Math.max(48, (x2 - x1) / 2));
  return { from: source.id, to: target.id, kind: live ? "active" : "need", arrow: true, curve };
}

// The chain a ticket belongs to: what blocks it and what it blocks, reached through
// `needs` in either direction — a chain is one connected group of dependents, so the
// walk ignores which way an edge points. Both sides, since half of what a map says is
// what a ticket unlocks.
export function chainOf(b, id) {
  const nodes = (b?.plan ?? []).filter((n) => n.level === "component");
  const next = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const need of n.needs ?? []) {
      if (!next.has(need)) continue;
      next.get(need).push(n.id);
      next.get(n.id).push(need);
    }
  }
  const seen = new Set([id]);
  if (!next.has(id)) return seen;
  const queue = [id];
  while (queue.length) {
    for (const other of next.get(queue.pop()) ?? []) if (!seen.has(other)) { seen.add(other); queue.push(other); }
  }
  return seen;
}

// A chain's edges carry dashes that travel from the ticket that blocks to the one it
// unblocks. A path's dashes are baked when it is built and GPUI has no dash offset, so the
// runs are cut here: the curve flattened at this zoom, then a dash every FLOW_PERIOD screen
// pixels, shifted forward by the phase. Screen pixels, so the flow looks the same at any zoom.
export const FLOW_DASH = 6, FLOW_GAP = 8, FLOW_PERIOD = FLOW_DASH + FLOW_GAP;
const FLOW_STEPS = 24;

export function flowTrack(curve, z) {
  const { x1, y1, ax, ay, bx, by, x2, y2 } = curve;
  const pts = [];
  for (let i = 0; i <= FLOW_STEPS; i += 1) {
    const t = i / FLOW_STEPS, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    pts.push([(a * x1 + b * ax + c * bx + d * x2) * z, (a * y1 + b * ay + c * by + d * y2) * z]);
  }
  const len = [0];
  for (let i = 1; i < pts.length; i += 1) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, len, total: len[len.length - 1] };
}

// The point `s` pixels along a track, and the index of the segment it falls in.
function along(track, s) {
  const { pts, len } = track;
  let i = 1;
  while (i < len.length - 1 && len[i] < s) i += 1;
  const span = len[i] - len[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (s - len[i - 1]) / span));
  return { i, p: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f] };
}

// Each dash as a polyline that follows the curve: [[x, y], …]. `phase` in [0, FLOW_PERIOD).
export function flowDashes(track, phase) {
  const runs = [];
  for (let s = phase - FLOW_PERIOD; s < track.total; s += FLOW_PERIOD) {
    const from = Math.max(0, s), to = Math.min(track.total, s + FLOW_DASH);
    if (to - from < 0.5) continue;
    const a = along(track, from), b = along(track, to);
    runs.push([a.p, ...track.pts.slice(a.i, b.i), b.p]);
  }
  return runs;
}

export function boardEdges(b, L) {
  const { phases, byId, pos } = L;
  const edges = phases.flatMap((p) => (p.needs ?? [])
    .filter((n) => byId[n] && pos[n] && pos[p.id])
    .map((n) => needEdge(byId[n], p, pos)));
  return { edges };
}

// ---- choosing a way through the chain.
//
// A chain is one connected group, so a ticket can sit on several ways through it. A route
// records the ways someone picked, one line at a time: it starts on the ticket they lit,
// and each chosen line moves its tip to that line's far end.

// The ticket at the far end of a line, seen from `id`.
export const otherEnd = (e, id) => (e.from === id ? e.to : e.from);

// The lines that meet a ticket. The ones it leads on come first, then the ones that lead
// back to it, each in reading order: left to right, then top to bottom, so the keyboard
// walks them the way the eye does.
export function waysFrom(geo, id) {
  const at = (e) => geo.L.pos[otherEnd(e, id)] ?? { x: 0, y: 0 };
  const ahead = (e) => (e.from === id ? 0 : 1);
  return (geo?.edges ?? []).filter((e) => e.from === id || e.to === id)
    .sort((a, c) => ahead(a) - ahead(c) || at(a).x - at(c).x || at(a).y - at(c).y);
}

// How far a point is from a flattened curve, in the same screen pixels the track is in.
function distanceTo(track, x, y) {
  const { pts } = track;
  let best = Infinity;
  for (let i = 1; i < pts.length; i += 1) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    const dx = x2 - x1, dy = y2 - y1, span = dx * dx + dy * dy;
    const f = span ? Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / span)) : 0;
    const d = Math.hypot(x - (x1 + dx * f), y - (y1 + dy * f));
    if (d < best) best = d;
  }
  return best;
}

// The line under a point of the canvas, or null. Lines are painted paths with no hitbox of
// their own, so a press picks the nearest curve within `within` screen pixels instead.
export function edgeNear(geo, z, x, y, within = 8) {
  let found = null, best = within;
  for (const e of geo?.edges ?? []) {
    const d = distanceTo(flowTrack(e.curve, z), x, y);
    if (d <= best) { best = d; found = e; }
  }
  return found;
}

export const statusLabel = (s) => (s === "done" ? "已完成" : s === "active" ? "进行中" : s === "blocked" ? "受阻" : "可开工");

export const ago = (ms, now) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
};

// The card a narrow view should open on: where work is declared, then the freshest file.
export function liveCard(b, now) {
  const comps = b.plan.filter((n) => n.level === "component");
  const newest = (list) => [...list].sort((a, c) => (c.touchedAt ?? 0) - (a.touchedAt ?? 0))[0];
  return (newest(comps.filter((p) => p.status === "active")) ?? newest(comps.filter((p) => touched(p, now))))?.id ?? null;
}

// The first thing anyone can start: nothing blocks it.
export function openingCard(b, now) {
  const found = liveCard(b, now);
  if (found || b.effort?.current) return found ?? b.effort.current;
  const comps = b.plan.filter((n) => n.level === "component");
  return (comps.find((n) => n.status === "pending" && !n.needs.length) ?? comps[0])?.id ?? null;
}

const sameProps = (a, c) => JSON.stringify(a ?? {}) === JSON.stringify(c ?? {});

// Is a block in this layout tree showing this mod with these props?
export function dockedIn(node, mod, props) {
  if (!node || typeof node !== "object" || node.hidden) return false;
  if (Array.isArray(node)) return node.some((n) => dockedIn(n, mod, props));
  if (node.content?.mod === mod && sameProps(node.content.props, props)) return true;
  return dockedIn(node.children, mod, props) || dockedIn(node.floating, mod, props);
}

// Where this copy lives. Herdr tells a mod neither its pane nor its block: props() is
// only what it was given. So a block is found by matching props in layout(), and a pane
// among the panes of the shown tab. An unclear case counts as a block, the safe side:
// a stray pane.zoom would zoom someone else's pane, a stray tab.new only opens a tab.
//   overlay: summoned by mod.open     block: docked, expand opens a tab
//   pane: beside others, expand zooms it
//   tab: an expanded tab, collapse closes  lone: already the whole tab, nothing to do
export function hostOf({ layout, props, panes, tab, focusedPane, mod }) {
  if (props?.overlay) return { kind: "overlay" };
  const here = panes.filter((p) => p.tab === tab);
  const mine = here.filter((p) => p.mod === mod);
  const pane = mine.find((p) => p.pane === focusedPane) ?? mine[0];
  if (!pane || dockedIn(layout, mod, props)) return { kind: "block" };
  if (here.length > 1) return { kind: "pane", pane: pane.pane, zoomed: pane.zoomed };
  return { kind: props?.expanded ? "tab" : "lone", pane: pane.pane };
}
