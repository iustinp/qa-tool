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

// coarse count bucket: 1,2,3,"4+". Makes the signature tolerant of variable INTERNAL length
// (a content block with 5 vs 6 vs 7 body lines groups as one), while the GCD reduction below
// separately absorbs MULTIPLICITY (2 vs 3 cards). Together: fuzzy grouping of the same block.
function countBucket(c) { return c <= 1 ? '' : c === 2 ? ':2' : c === 3 ? ':3' : ':4+'; }

function canonical(region) {
  const counts = new Map();
  for (const n of region.nodes) { const t = styleToken(n); counts.set(t, (counts.get(t) || 0) + 1); }
  const entries = [...counts.entries()];
  const maxC = Math.max(...entries.map(([, c]) => c));

  // Separate a lone section-heading / scaffolding (tokens appearing ONCE) from the REPEATED
  // items before taking the GCD — otherwise a single heading above a card grid (count 1) drags
  // the GCD to 1 and the collection is missed (was typed Hero instead of Cards). The repeat
  // multiplicity is the GCD of the repeated (count>=2) tokens; singletons ride along at count 1.
  let bulk = entries, extras = [], g = 1;
  if (maxC >= 2) {
    const rep = entries.filter(([, c]) => c >= 2);       // repeated tokens
    const gg = gcdAll(rep.map(([, c]) => c));
    // a REAL collection is a multi-part unit repeated (>=2 distinct repeated tokens) OR a single
    // token repeated many times (a long list). A lone token appearing 2-3x among singletons
    // (e.g. two byline lines in a header) is NOT a collection.
    const realCollection = gg >= 2 && (rep.length >= 2 || (rep.length === 1 && rep[0][1] >= 4));
    if (realCollection) { extras = entries.filter(([, c]) => c === 1); bulk = rep; g = gg; }
  }
  const unit = [
    ...bulk.map(([t, c]) => [t, Math.max(1, Math.round(c / g))]),
    ...extras.map(([t]) => [t, 1]),
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const key = unit.map(([t, c]) => `${t}${countBucket(c)}`).join('+');
  const unitSize = unit.reduce((s, [, c]) => s + c, 0);
  return { key, unit, repeat: g, unitSize };
}

// Algorithmic EDS block-type guess from the canonical unit + example geometry (heuristic).
// FUTURE (issue #65): this structure->type mapping is CROSS-site knowledge (unlike per-site
// discovery), so it is the natural place to plug a learned store of validated
// (feature-vector -> EDS type) examples, with these rules as the fallback. Keep the decision a
// pure function of content-blind structural features so a learned model can slot in here.
function guessType(unit, isCollection, example) {
  const toks = unit.map(([t]) => t);
  const hasImg = toks.some((t) => t.startsWith('IMG'));
  const sizes = toks.filter((t) => t[0] === 'T').map((t) => parseInt(t.slice(1), 10) || 0);
  const size = unit.reduce((s, [, c]) => s + c, 0);
  const maxS = sizes.length ? Math.max(...sizes) : 0;
  const minS = sizes.length ? Math.min(...sizes) : 0;
  const reg = example && example.region;
  const wide = reg ? reg.w > reg.h * 1.2 : false;
  // a dominant single heading: the largest tier is big, clearly larger than the rest, appears once
  const bigOnce = unit.some(([t, c]) => t[0] === 'T' && parseInt(t.slice(1), 10) === maxS && c === 1);
  const dominantHeading = bigOnce && maxS >= 22 && maxS >= minS * 1.5;

  if (isCollection && hasImg) return 'Cards / Teasers';
  if (isCollection && !hasImg) return wide ? 'Columns' : 'List / Accordion';
  if (!isCollection && hasImg) return dominantHeading && maxS >= 30 ? 'Hero' : 'Media / Image + text';
  if (dominantHeading) return 'Header / Title';
  if (maxS <= 13 && size <= 3) return 'Meta / label';
  return 'Heading + text';
}

const SIM = 0.88;       // cosine threshold for "same block"
const SIZE_RATIO = 0.6; // and node counts within this ratio (a blob can't swallow a small card)

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, c] of a) na += c * c;
  for (const [, c] of b) nb += c * c;
  for (const [t, c] of a) { const d = b.get(t); if (d) dot += c * d; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// perPage: [{url, regions}] -> ranked catalog of block units.
// Group by cosine similarity over the GCD-reduced UNIT token vectors: reducing by GCD first
// normalises MULTIPLICITY (1 card vs a 3-card row → same size-4 unit), then cosine tolerates
// ±body-lines and an optional token, and a unit-SIZE gate stops a big blob from swallowing a
// small card. Greedy single pass over units ordered by size desc (deterministic); each joins the
// first cluster within SIM+size, else seeds a new one (largest unit = representative).
function buildCatalog(perPage) {
  const items = [];
  for (const pg of perPage) for (const r of pg.regions) if (r.type === 'block') {
    const c = canonical(r);
    items.push({ r, url: pg.url, c, vec: new Map(c.unit), size: c.unitSize });
  }
  items.sort((a, b) => b.size - a.size || (a.c.key < b.c.key ? -1 : 1));

  const clusters = [];
  for (const it of items) {
    let hit = null;
    for (const cl of clusters) {
      const ratio = Math.min(it.size, cl.repSize) / Math.max(it.size, cl.repSize);
      if (ratio >= SIZE_RATIO && cosine(it.vec, cl.repVec) >= SIM) { hit = cl; break; }
    }
    if (!hit) { hit = { repVec: it.vec, repSize: it.size, rep: it.c, example: { region: it.r, url: it.url }, pages: new Set(), instances: 0, maxRepeat: 1, samples: new Set() }; clusters.push(hit); }
    hit.pages.add(it.url); hit.instances++; hit.maxRepeat = Math.max(hit.maxRepeat, it.c.repeat);
    if (it.r.count > hit.example.region.count) hit.example = { region: it.r, url: it.url };
    for (const n of it.r.nodes) if (n.kind === 'text' && n.text && hit.samples.size < 6) hit.samples.add(n.text.slice(0, 46));
  }

  const rows = clusters.map((cl) => ({
    key: cl.rep.key, unit: cl.rep.unit, unitSize: cl.rep.unitSize, example: cl.example,
    pages: cl.pages, pageCount: cl.pages.size, instances: cl.instances, maxRepeat: cl.maxRepeat,
    isCollection: cl.maxRepeat >= 2, type: guessType(cl.rep.unit, cl.maxRepeat >= 2, cl.example), samples: [...cl.samples],
  }));
  return rows.sort((a, b) => b.pageCount - a.pageCount || b.instances - a.instances);
}

module.exports = { canonical, guessType, buildCatalog };
