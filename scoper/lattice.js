/*
 * Lattice / periodicity detector (issue #65) — the linchpin for typing.
 *
 * Key architecture (the user's own card definition: "an image and some texts AROUND the image"):
 * IMAGES localise, TEXT is promiscuous (the same text token appears in the cards AND the body).
 * So we ANCHOR on images:
 *   1. detect image lattices (2D grid / 1D row / 1D column of same-aspect images by translational
 *      symmetry) — these resolve cleanly because images only live where the block is;
 *   2. assign each cell's LOCAL surrounding text to that image cell (nearest image within a cell
 *      radius) -> the peer's composition, without fighting text promiscuity.
 * A SECONDARY pass finds text-only lattices (list/columns/grid, no image) with a COMPACTNESS guard
 * (reject page-spanning smears) and the prose filter (block only if multi-token or 2D).
 *
 * Output per peer: {kind:'image'|'text', axis:2D/H/V, period, count, tokens[], hasImage, is2D, block, bbox}.
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
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

// arrangement of ONE token's nodes: 2D grid, or 1D H/V even-spaced run, or null
function tokenLattice(group) {
  const hband = Math.max(8, median(group.map((n) => n.h)) * 0.8);
  const wband = Math.max(8, median(group.map((n) => n.w)) * 0.8);
  const rows = clusterBand(group, cy, hband).filter((r) => r.length >= 2);
  const cols = clusterBand(group, cx, wband).filter((c) => c.length >= 2);
  if (rows.length >= 2 && cols.length >= 2 && group.length >= 4) {
    const px = median(rows.flatMap((r) => { r.sort((a, b) => cx(a) - cx(b)); return r.slice(1).map((n, i) => cx(n) - cx(r[i])); }));
    return { kind: '2D', nodes: group, bbox: bboxOf(group), period: Math.round(px) };
  }
  let h = null; for (const r of rows) { const e = evenRun(r, cx); if (e && (!h || e.nodes.length > h.nodes.length)) h = e; }
  let v = null; for (const c of cols) { const e = evenRun(c, cy); if (e && (!v || e.nodes.length > v.nodes.length)) v = e; }
  const pick = h && (!v || h.nodes.length >= v.nodes.length) ? { ...h, kind: 'H' } : (v ? { ...v, kind: 'V' } : null);
  if (!pick) return null;
  return { kind: pick.kind, nodes: pick.nodes, bbox: bboxOf(pick.nodes), period: pick.period };
}

// --- image-anchored peers: image lattice + local text per cell ---------------
function imagePeers(nodes) {
  const imgs = nodes.filter((n) => n.kind !== 'text');
  const texts = nodes.filter((n) => n.kind === 'text');
  const byTok = new Map();
  for (const n of imgs) { const t = styleToken(n); if (!byTok.has(t)) byTok.set(t, []); byTok.get(t).push(n); }
  const peers = [];
  for (const [tok, group] of byTok) {
    if (group.length < 3) continue;
    const L = tokenLattice(group);
    if (!L) continue;
    const cells = L.nodes;
    const radius = Math.max(L.period || 160, 140);
    const assignedByCell = cells.map(() => []);
    const used = new Set();
    for (const t of texts) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < cells.length; i++) { const d = Math.hypot(cx(t) - cx(cells[i]), cy(t) - cy(cells[i])); if (d < bd) { bd = d; bi = i; } }
      if (bi >= 0 && bd < radius) { assignedByCell[bi].push(t); used.add(t); }
    }
    // text tokens present in a majority of cells = the card's consistent composition
    const tokCells = new Map();
    for (const arr of assignedByCell) for (const t of new Set(arr.map(styleToken))) tokCells.set(t, (tokCells.get(t) || 0) + 1);
    const consistent = [...tokCells].filter(([, c]) => c >= Math.max(2, cells.length * 0.4)).map(([t]) => t);
    peers.push({
      kind: 'image', axis: L.kind, period: L.period, count: cells.length,
      tokens: [tok, ...consistent], hasImage: true, is2D: L.kind === '2D', block: true,
      bbox: bboxOf([...cells, ...used]), _text: used,
    });
  }
  return peers;
}

// --- text-only peers (secondary): compact, non-overlapping, prose-filtered ---
function textPeers(nodes, imgPeers, pageH) {
  const taken = new Set(); for (const p of imgPeers) for (const t of p._text) taken.add(t);
  const texts = nodes.filter((n) => n.kind === 'text' && !taken.has(n));
  const byTok = new Map();
  for (const n of texts) { const t = styleToken(n); if (!byTok.has(t)) byTok.set(t, []); byTok.get(t).push(n); }
  const lats = [];
  for (const group of byTok.values()) { if (group.length >= 3) { const L = tokenLattice(group); if (L) { L.tok = styleToken(group[0]); lats.push(L); } } }
  lats.sort((a, b) => b.nodes.length - a.nodes.length);
  const peers = [];
  for (const L of lats) {
    let P = peers.find((p) => iou(p.bbox, L.bbox) >= 0.4 && (p.kind === '2D' || L.kind === '2D' || (p.kind === L.kind && Math.abs(p.period - L.period) <= Math.max(24, p.period * 0.35))));
    if (!P) { P = { kind: L.kind, period: L.period, toks: new Set(), nodes: [], bbox: L.bbox }; peers.push(P); }
    P.toks.add(L.tok); P.nodes.push(...L.nodes); P.bbox = bboxOf(P.nodes); if (L.kind === '2D') P.kind = '2D';
  }
  return peers.map((P) => {
    const is2D = P.kind === '2D';
    const compact = P.bbox.h < pageH * 0.6;                    // reject page-spanning smears
    const distinctTokens = P.toks.size;
    return {
      kind: 'text', axis: is2D ? '2D' : P.kind, period: P.period,
      count: Math.max(3, Math.round(P.nodes.length / Math.max(1, distinctTokens))),
      tokens: [...P.toks], hasImage: false, is2D, block: compact && (distinctTokens >= 2 || is2D), bbox: P.bbox,
    };
  });
}

function detectPageLattices(nodes) {
  const pageH = Math.max(...nodes.map((n) => n.y + n.h), 1);
  const imgP = imagePeers(nodes);
  const txtP = textPeers(nodes, imgP, pageH).filter((p) => !imgP.some((ip) => iou(ip.bbox, p.bbox) > 0.3));
  return [...imgP, ...txtP].filter((P) => P.block).sort((a, b) => (b.hasImage - a.hasImage) || (b.count - a.count));
}

module.exports = { detectPageLattices };
