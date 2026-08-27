/*
 * Lattice / periodicity detector (issue #65) — the linchpin for typing.
 *
 * The eye sees the RHYTHM before the individual item. A repeating peer is translational symmetry:
 * the same content-blind token at a regular period. Per token we detect its arrangement —
 *   - 2D GRID: >=2 rows AND >=2 columns (a card grid / gallery / text grid; "at least 2x2"), or
 *   - 1D H / V: a single even-spaced row (>=3) or column (>=3) —
 * then MERGE the per-token lattices that occupy the same region into one PEER (a card's image +
 * title + cta lattices coincide -> one peer). Finally the PROSE FILTER keeps a peer as a block
 * only if it is multi-token, image-involved, or 2D; a lone single-token 1D text stack is prose.
 *
 * Output per peer: axis (2D/H/V), period, count, token composition, hasImage, is2D, block flag.
 */

const { styleToken } = require('./signature');

const cx = (n) => n.x + n.w / 2;
const cy = (n) => n.y + n.h / 2;
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
const bboxOf = (ns) => {
  const x = Math.min(...ns.map((n) => n.x)), y = Math.min(...ns.map((n) => n.y));
  return { x, y, w: Math.max(...ns.map((n) => n.x + n.w)) - x, h: Math.max(...ns.map((n) => n.y + n.h)) - y };
};
const clusterBand = (group, coord, band) => {
  const m = new Map();
  for (const n of group) { const k = Math.round(coord(n) / band); if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
  return [...m.values()];
};
// longest even-spaced contiguous run (>=3) along coord
function evenRun(arr, coord) {
  arr = [...arr].sort((a, b) => coord(a) - coord(b));
  let best = null, run = [arr[0]], period = null;
  const consider = () => { if (run.length >= 3 && (!best || run.length > best.nodes.length)) best = { nodes: run.slice(), period: Math.round(period) }; };
  for (let i = 1; i < arr.length; i++) {
    const gap = coord(arr[i]) - coord(arr[i - 1]);
    if (gap < 2) continue;
    if (period === null) { period = gap; run.push(arr[i]); }
    else if (gap >= period * 0.7 && gap <= period * 1.4) { run.push(arr[i]); period = period * 0.6 + gap * 0.4; }
    else { consider(); run = [arr[i]]; period = null; }
  }
  consider();
  return best;
}
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1); // intersection over UNION (co-extensive only)
};

// arrangement of ONE token's nodes: 2D grid, or 1D H/V, or null
function tokenLattice(group) {
  const hband = Math.max(8, median(group.map((n) => n.h)) * 0.8);
  const wband = Math.max(8, median(group.map((n) => n.w)) * 0.8);
  const rows = clusterBand(group, cy, hband).filter((r) => r.length >= 2);
  const cols = clusterBand(group, cx, wband).filter((c) => c.length >= 2);
  const tok = styleToken(group[0]);
  if (rows.length >= 2 && cols.length >= 2 && group.length >= 4) {
    const px = median(rows.flatMap((r) => { r.sort((a, b) => cx(a) - cx(b)); return r.slice(1).map((n, i) => cx(n) - cx(r[i])); }));
    return { kind: '2D', tok, nodes: group, bbox: bboxOf(group), period: Math.round(px), lines: rows.length };
  }
  let h = null; for (const r of rows) { const e = evenRun(r, cx); if (e && (!h || e.nodes.length > h.nodes.length)) h = e; }
  let v = null; for (const c of cols) { const e = evenRun(c, cy); if (e && (!v || e.nodes.length > v.nodes.length)) v = e; }
  const pick = h && (!v || h.nodes.length >= v.nodes.length) ? { ...h, kind: 'H' } : (v ? { ...v, kind: 'V' } : null);
  if (!pick) return null;
  return { kind: pick.kind, tok, nodes: pick.nodes, bbox: bboxOf(pick.nodes), period: pick.period, lines: 1 };
}

function compatible(P, L) {
  const ov = iou(P.bbox, L.bbox);
  if (ov < 0.4) return false;                          // only co-extensive lattices (union IoU)
  if (P.kind === '2D' || L.kind === '2D') return true; // same region + a grid present -> same peer
  return P.kind === L.kind && Math.abs(P.period - L.period) <= Math.max(24, P.period * 0.35);
}

function detectPageLattices(nodes) {
  const byTok = new Map();
  for (const n of nodes) { const t = styleToken(n); if (!byTok.has(t)) byTok.set(t, []); byTok.get(t).push(n); }

  const lats = [];
  for (const group of byTok.values()) { if (group.length >= 3) { const L = tokenLattice(group); if (L) lats.push(L); } }
  lats.sort((a, b) => b.nodes.length - a.nodes.length);

  const peers = [];
  for (const L of lats) {
    let peer = peers.find((P) => compatible(P, L));
    if (!peer) { peer = { kind: L.kind, period: L.period, chains: [], nodes: [], bbox: L.bbox }; peers.push(peer); }
    peer.chains.push(L);
    peer.nodes.push(...L.nodes);
    peer.bbox = bboxOf(peer.nodes);
    if (L.kind === '2D') peer.kind = '2D';
  }

  return peers.map((P) => {
    const tokCount = new Map();
    for (const c of P.chains) tokCount.set(c.tok, (tokCount.get(c.tok) || 0) + 1);
    const tokens = [...tokCount.keys()];
    const hasImage = tokens.some((t) => t.startsWith('IMG'));
    const is2D = P.kind === '2D';
    const perTok = P.chains.reduce((m, c) => (m[c.tok] = (m[c.tok] || 0) + c.nodes.length, m), {});
    const count = Math.max(...Object.values(perTok));            // instance count (grid cells / row items)
    const distinctTokens = tokens.length;
    const block = hasImage || distinctTokens >= 2 || is2D;       // prose filter (accordion adds affordance later)
    return {
      axis: is2D ? '2D' : P.kind, period: P.period, count, tokens: [...tokCount.keys()],
      hasImage, is2D, distinctTokens, block, bbox: P.bbox,
    };
  }).filter((P) => (P.count >= 3 || P.is2D)).sort((a, b) => (b.block - a.block) || (b.count - a.count));
}

module.exports = { detectPageLattices };
