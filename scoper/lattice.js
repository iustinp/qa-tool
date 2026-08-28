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

// --- image-anchored peers: FOLD the region into period-windows (level-2 group) -
// Level 1 = repeating images / repeating texts. Level 2 = realising one text belongs to one
// image, so the image+text GROUP repeats. We detect the image lattice (period + axis), then slice
// space into one period-window PER image cell; each window captures that whole card (image + its
// own text) -> the group. The group repetition supersedes the base image/text repetitions.
function imagePeers(nodes) {
  const imgs = nodes.filter((n) => n.kind !== 'text');
  const byTok = new Map();
  for (const n of imgs) { const t = styleToken(n); if (!byTok.has(t)) byTok.set(t, []); byTok.get(t).push(n); }
  const peers = [];
  for (const group of byTok.values()) {
    if (group.length < 3) continue;
    const L = tokenLattice(group);
    if (!L) continue;
    const cells = L.nodes;
    const P = L.period || 160;
    // FOLD each image cell into one group instance = image + the nodes that belong to it.
    // 2D grid: a cell is bounded in both axes (±px/2, ±py/2). 1D: bind by ALONG-axis alignment
    // only (a text in the same row/slice as the image belongs to it) — NO cross bound, so a wide
    // card's far-side text still joins; the consistency filter drops anything not in most cells.
    let instances;
    if (L.kind === '2D') {
      const band = Math.max(8, median(cells.map((n) => n.h)) * 0.8);
      const rowY = clusterBand(cells, cy, band).map((r) => median(r.map(cy))).sort((a, b) => a - b);
      const py = median(rowY.slice(1).map((y, i) => y - rowY[i])) || P;
      const hx = P / 2, hy = py / 2;
      instances = cells.map((c) => nodes.filter((n) => Math.abs(cx(n) - cx(c)) < hx && Math.abs(cy(n) - cy(c)) < hy));
    } else {
      // 1D: within the along-window, grow a CROSS-contiguous cluster out from the image, breaking
      // at a whitespace gap — so a card = image + adjacent text, not a full-height strip that
      // swallows a header/footer sitting at the same x (the tall-thin-box bug).
      const along = L.kind === 'H' ? cx : cy, cross = L.kind === 'H' ? cy : cx;
      const crossGap = Math.max(40, P * 0.6);
      instances = cells.map((c) => {
        const win = nodes.filter((n) => Math.abs(along(n) - along(c)) < P / 2).sort((a, b) => cross(a) - cross(b));
        const ci = win.indexOf(c);
        if (ci < 0) return [c];
        const keep = [c];
        for (let i = ci + 1; i < win.length; i++) { if (cross(win[i]) - cross(win[i - 1]) < crossGap) keep.push(win[i]); else break; }
        for (let i = ci - 1; i >= 0; i--) { if (cross(win[i + 1]) - cross(win[i]) < crossGap) keep.push(win[i]); else break; }
        return keep;
      });
    }
    // consistent composition = tokens present in >=40% of the groups
    const tokCells = new Map();
    for (const inst of instances) for (const t of new Set(inst.map(styleToken))) tokCells.set(t, (tokCells.get(t) || 0) + 1);
    const keep = new Set([...tokCells].filter(([, c]) => c >= Math.max(2, cells.length * 0.4)).map(([t]) => t));
    const instNodes = instances.map((inst) => inst.filter((n) => keep.has(styleToken(n)))).filter((a) => a.length);
    const flat = instNodes.flat();
    if (!flat.length) continue;
    peers.push({
      kind: 'image', axis: L.kind, period: P, count: cells.length,
      tokens: [...keep].sort((a, b) => (b.startsWith('IMG') ? 1 : 0) - (a.startsWith('IMG') ? 1 : 0)),
      hasImage: true, is2D: L.kind === '2D', block: true,
      bbox: bboxOf(flat), instances: instNodes.map(bboxOf), instanceNodes: instNodes,
      _text: new Set(flat.filter((n) => n.kind === 'text')),
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
