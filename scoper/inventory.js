/*
 * scoper/inventory.js — cross-page block inventory + counts (issue #65).
 *
 * The scoping deliverable: across a whole corpus, collapse the per-page BLOCK bands (from
 * band-cut + band-class) into a small set of distinct block TYPES, each with page/instance counts
 * (= the migration-effort estimate). Content-blind signature = the SET of style-tokens in the band
 * (multiplicity ignored, so a 2-card and a 4-card row of the same block collapse); grouped
 * exact-first, then near-duplicates fuzzy-merged into the highest-reach anchors (so minor
 * variation — an optional eyebrow — doesn't fragment the type, the failure of the old catalog).
 */

const { styleToken } = require('./signature');
const { classifyPage } = require('./band-class');

const ICON = 64; // drop tiny icon images from the signature (consistent with band-class size floor)

function bandTokenSet(bandNodes) {
  const s = new Set();
  for (const n of bandNodes) {
    if (n.kind !== 'text' && Math.min(n.w, n.h) < ICON) continue;
    s.add(styleToken(n));
  }
  return s;
}
function jaccard(a, b) { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); }
function majority(items, key) {
  const m = new Map();
  for (const it of items) m.set(it[key], (m.get(it[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function buildInventory(pears, keyBucket, opts = {}) {
  const SIM = opts.sim != null ? opts.sim : 0.6;

  // 1) every block band across the corpus, with its content-blind token set
  const items = [];
  for (const pg of pears) {
    for (const b of classifyPage(pg, keyBucket, { store: opts.store })) {
      if (b.cls !== 'block') continue;
      const bn = pg.nodes.filter((n) => (n.y + n.h) > b.y0 && n.y < b.y1);
      const set = bandTokenSet(bn);
      if (set.size) items.push({ set, subtype: b.subtype, url: pg.url, dir: pg.dir, y0: b.y0, y1: b.y1, dpr: pg.dpr || 1 });
    }
  }

  // 2) exact grouping by token-set, then fuzzy-merge small groups into higher-reach anchors
  const exact = new Map();
  for (const it of items) {
    const k = [...it.set].sort().join('+');
    if (!exact.has(k)) exact.set(k, { set: it.set, items: [], pages: new Set() });
    const g = exact.get(k); g.items.push(it); g.pages.add(it.url);
  }
  const groups = [...exact.values()].sort((a, b) => b.pages.size - a.pages.size || b.items.length - a.items.length);
  const kept = [];
  for (const g of groups) {
    let host = null, hs = SIM;
    for (const k of kept) { const s = jaccard(g.set, k.set); if (s >= hs) { host = k; hs = s; } }
    if (host) { host.items.push(...g.items); for (const u of g.pages) host.pages.add(u); }
    else kept.push({ set: g.set, items: [...g.items], pages: new Set(g.pages) });
  }

  return kept.map((c) => ({
    subtype: majority(c.items, 'subtype'),
    pages: c.pages.size,
    instances: c.items.length,
    signature: [...c.set].sort().join('+'),
    example: c.items[0].url,
    occurrences: c.items.map((it) => ({ url: it.url, dir: it.dir, y0: it.y0, y1: it.y1, dpr: it.dpr })),
  })).sort((a, b) => b.pages - a.pages || b.instances - a.instances);
}

module.exports = { buildInventory };
