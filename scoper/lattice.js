/*
 * Lattice / periodicity detector (issue #65) — the linchpin for typing.
 *
 * The eye sees the RHYTHM before the individual card. A repeating peer (card, column, FAQ row,
 * grid cell) shows up as translational symmetry: many nodes of the same content-blind token sit
 * at a constant OFFSET from their same-token neighbour (the period). Tokens that share a period
 * belong to the same peer; the period vector gives the AXIS (horizontal row / vertical stack /
 * 2D grid) and the chain length gives the COUNT. No content, no segmentation guesswork — the
 * peer boundary falls out of the period.
 *
 * This is a SPIKE: prove it finds real peers/periods on existing runs before building typing.
 */

const { styleToken } = require('./signature');

const center = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
// fold sign so +v and -v are the same period direction (dx>=0; ties broken by dy)
const foldSign = (dx, dy) => (dx < 0 || (dx === 0 && dy < 0) ? [-dx, -dy] : [dx, dy]);
const qbucket = (v, q = 24) => `${Math.round(v[0] / q) * q},${Math.round(v[1] / q) * q}`;

// nearest same-token neighbour offset for each node in a group
function neighbourOffsets(group) {
  const offs = [];
  for (let i = 0; i < group.length; i++) {
    let best = null, bd = Infinity;
    const a = center(group[i]);
    for (let j = 0; j < group.length; j++) {
      if (i === j) continue;
      const b = center(group[j]);
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < bd) { bd = d; best = foldSign(Math.round(b.x - a.x), Math.round(b.y - a.y)); }
    }
    if (best) offs.push(best);
  }
  return offs;
}

function axisOf([dx, dy]) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ay <= ax * 0.35) return 'H';
  if (ax <= ay * 0.35) return 'V';
  return 'D';
}

// nodes of ONE page -> detected lattices [{axis, period, count, tokens:[{tok,n}], support, bbox}]
function detectPageLattices(nodes) {
  // group nodes by content-blind token
  const byTok = new Map();
  for (const n of nodes) { const t = styleToken(n); if (!byTok.has(t)) byTok.set(t, []); byTok.get(t).push(n); }

  // per token: dominant period vector (bucketed) + support
  const tokPeriods = [];
  for (const [tok, group] of byTok) {
    if (group.length < 3) continue;
    const hist = new Map();
    for (const o of neighbourOffsets(group)) {
      const k = qbucket(o);
      if (!hist.has(k)) hist.set(k, { vec: o, c: 0 });
      hist.get(k).c++;
    }
    const dom = [...hist.values()].sort((a, b) => b.c - a.c)[0];
    if (!dom || dom.c < 2) continue;                    // need >=3 nodes in a chain
    tokPeriods.push({ tok, group, vec: dom.vec, support: dom.c });
  }

  // merge tokens that share a period vector (same rhythm) into one lattice
  const lattices = [];
  for (const tp of tokPeriods) {
    let lat = lattices.find((L) => Math.hypot(L.period[0] - tp.vec[0], L.period[1] - tp.vec[1]) <= 30);
    if (!lat) { lat = { period: tp.vec, tokens: [], support: 0, members: [] }; lattices.push(lat); }
    lat.tokens.push({ tok: tp.tok, n: tp.group.length });
    lat.support = Math.max(lat.support, tp.support);
    lat.members.push(...tp.group);
  }

  return lattices.map((L) => {
    const period = Math.round(Math.hypot(L.period[0], L.period[1]));
    const xs = L.members.map((n) => n.x), ys = L.members.map((n) => n.y);
    const x2 = L.members.map((n) => n.x + n.w), y2 = L.members.map((n) => n.y + n.h);
    return {
      axis: axisOf(L.period), period, count: L.support + 1,
      tokens: L.tokens.sort((a, b) => b.n - a.n),
      bbox: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...x2) - Math.min(...xs), h: Math.max(...y2) - Math.min(...ys) },
    };
  }).sort((a, b) => b.count - a.count);
}

module.exports = { detectPageLattices };
