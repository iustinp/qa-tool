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

const fs = require('fs');
const path = require('path');
const { styleToken } = require('./signature');
const { classifyPage } = require('./band-class');
const { nodesInRect } = require('./features');

const ICON = 64; // drop tiny icon images from the signature (consistent with band-class size floor)

// A page's CSS document size (screenshot px / dpr), so region rects (stored 0..1 of the full image)
// map back to node coordinates; falls back to the node extent when there's no screenshot.
function pageCssDims(pg) {
  let pngW = 0, pngH = 0;
  try { const b = fs.readFileSync(path.join(pg.dir, 'screenshots', 'source-full.png')); pngW = b.readUInt32BE(16); pngH = b.readUInt32BE(20); } catch { /* no shot */ }
  const dpr = pg.dpr || 1;
  return {
    wCss: pngW ? pngW / dpr : Math.max(100, ...pg.nodes.map((n) => n.x + n.w)),
    hCss: pngH ? pngH / dpr : Math.max(100, ...pg.nodes.map((n) => n.y + n.h)),
  };
}

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

  // 1b) apply human corrections as authoritative, exact per-corpus OVERRIDES — a correction states
  // ground truth for THIS corpus and must hold regardless of whether the learned store generalized.
  if (opts.overrides && Object.keys(opts.overrides).length) applyOverrides(items, pears, opts.overrides);

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

// Apply exact-band overrides in place. id = basename(dir)_round(y0), matching the visual's idOf.
//   reassign (verdict = a type) / new-type -> relabel that band's subtype (flows into the majority vote)
//   correct ('')                            -> affirm; leave as detected
//   fragment                                -> drop the band (it's not a standalone block of that type)
//   any drawn region                        -> add the region as an instance of its true type, and drop
//                                              tool bands overlapping it (so it isn't double-counted)
function applyOverrides(items, pears, overrides) {
  const remove = new Set();
  for (const it of items) {
    const c = overrides[`${path.basename(it.dir)}_${Math.round(it.y0)}`];
    if (!c) continue;
    const v = c.type || '';
    if (v === '__fragment__' || v === '__split__' || v === '__notblock__') remove.add(it); // over-cut piece, over-fused conglomerate, or wrongly-admitted default — drop from the inventory
    else if (v === '__new__') it.subtype = c.newName || '(unnamed)';
    else if (v === '__ok__') { /* confirmed as detected — affirm, no relabel */ }
    else if (v) it.subtype = v;
  }
  const additions = [];
  for (const [id, c] of Object.entries(overrides)) {
    if (!c.regions || !c.regions.length) continue;
    const slug = id.replace(/_\d+$/, '');
    const pg = pears.find((p) => path.basename(p.dir) === slug);
    if (!pg) continue;
    const { wCss, hCss } = pageCssDims(pg);
    for (const r of c.regions) {
      const rtype = r.type === '__new__' ? (r.newName || '(unnamed)') : r.type;
      if (!rtype) continue;
      const rect = { x: r.x * wCss, y: r.y * hCss, w: r.w * wCss, h: r.h * hCss };
      const set = bandTokenSet(nodesInRect(pg.nodes, rect));
      if (!set.size) continue;
      additions.push({ set, subtype: rtype, url: pg.url, dir: pg.dir, y0: rect.y, y1: rect.y + rect.h, dpr: pg.dpr || 1 });
      for (const it of items) {
        if (it.dir !== pg.dir) continue;
        const ov = Math.max(0, Math.min(it.y1, rect.y + rect.h) - Math.max(it.y0, rect.y));
        if (ov > 0.5 * Math.min(it.y1 - it.y0, rect.h)) remove.add(it);
      }
    }
  }
  for (let i = items.length - 1; i >= 0; i -= 1) if (remove.has(items[i])) items.splice(i, 1);
  items.push(...additions);
}

module.exports = { buildInventory };
