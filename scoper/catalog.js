/*
 * Step #3 — cross-page block catalog (issue #65).
 *
 * Canonicalise each block region to its REPEATING UNIT, then group units across all pages into
 * a site-wide catalog ranked by reach. This is the scoping deliverable: "the site has these N
 * block types, here is where each appears."
 *
 * Canonicalisation (fixes the #2 multiplicity wrinkle — a card row assembled as 1/2/3 cards):
 * take the region's style-token MULTISET and divide every count by their GCD. A single card
 * {IMG:1,eyebrow:1,title:1,CTA:1} and a 3-card row {IMG:3,...} both reduce to the same unit,
 * so all collapse to ONE block type. The GCD (>1) also tells us the region was a COLLECTION.
 * (Multiset, not sequence, so grid vs list reading-order doesn't matter — a known limitation is
 * that two different blocks sharing a token bag would collide; fine for a first catalog.)
 */

const { styleToken } = require('./signature');

function gcdAll(arr) { return arr.reduce((a, b) => { while (b) { [a, b] = [b, a % b]; } return a; }, 0) || 1; }

function canonical(region) {
  const counts = new Map();
  for (const n of region.nodes) { const t = styleToken(n); counts.set(t, (counts.get(t) || 0) + 1); }
  const g = gcdAll([...counts.values()]);
  const unit = [...counts.entries()].map(([t, c]) => [t, c / g]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const key = unit.map(([t, c]) => (c > 1 ? `${t}:${c}` : t)).join('+');
  const unitSize = unit.reduce((s, [, c]) => s + c, 0);
  return { key, unit, repeat: g, unitSize };
}

// algorithmic EDS block-type guess from the canonical unit (heuristic, first pass)
function guessType(unit, isCollection) {
  const toks = unit.map(([t]) => t);
  const hasImg = toks.some((t) => t.startsWith('IMG'));
  const tSizes = toks.filter((t) => t[0] === 'T').map((t) => parseInt(t.slice(1), 10) || 0);
  const tiers = new Set(tSizes).size;
  const size = unit.reduce((s, [, c]) => s + c, 0);
  if (hasImg && isCollection) return 'Cards / Teasers';
  if (hasImg && !isCollection && size <= 3) return 'Hero / Media + text';
  if (!hasImg && isCollection && tiers <= 1) return 'List / Columns';
  if (!hasImg && tiers >= 2) return 'Heading + text';
  if (hasImg) return 'Media';
  return 'Block';
}

// perPage: [{url, regions}] -> ranked catalog of block units
function buildCatalog(perPage) {
  const cat = new Map();
  for (const pg of perPage) {
    for (const r of pg.regions) {
      if (r.type !== 'block') continue;
      const c = canonical(r);
      let e = cat.get(c.key);
      if (!e) { e = { key: c.key, unit: c.unit, unitSize: c.unitSize, pages: new Set(), instances: 0, maxRepeat: 1, samples: new Set(), example: null }; cat.set(c.key, e); }
      e.pages.add(pg.url); e.instances++; e.maxRepeat = Math.max(e.maxRepeat, c.repeat);
      if (!e.example || r.count > e.example.count) e.example = { region: r, url: pg.url };
      for (const n of r.nodes) if (n.kind === 'text' && n.text && e.samples.size < 6) e.samples.add(n.text.slice(0, 46));
    }
  }
  const rows = [...cat.values()].map((e) => ({ ...e, isCollection: e.maxRepeat >= 2, type: guessType(e.unit, e.maxRepeat >= 2), pageCount: e.pages.size, samples: [...e.samples] }));
  return rows.sort((a, b) => b.pageCount - a.pageCount || b.instances - a.instances);
}

module.exports = { canonical, guessType, buildCatalog };
