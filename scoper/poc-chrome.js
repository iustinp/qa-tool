#!/usr/bin/env node
/*
 * Step #1 — chrome vs content-block discriminator (issue #65).
 *
 * On a templated site, cross-page FREQUENCY can't separate site-chrome from a content
 * block: both recur on ~every page. The clean, deterministic separator is VOCABULARY:
 *
 *   - site chrome  (footer/nav/legal): a FIXED small text vocabulary reused verbatim
 *     everywhere  -> distinctValues stays tiny no matter how many instances.
 *   - content block (cards/teasers):   vocabulary GROWS with instances (each card a new
 *     title / thumbnail) -> distinctValues ~= instances.
 *
 * There are THREE vocabulary regimes, not two (found on grace):
 *   1. fixed/tiny   — chrome & fixed labels ("Read more", nav): a handful of values that
 *                     never grow, reused verbatim everywhere.
 *   2. bounded pool — a "recent posts / related items" block reuses a small POOL (~45
 *                     articles) across all pages: many instances, few-dozen distinct.
 *   3. unbounded    — prose / dates: distinct grows with the corpus.
 * vocabRatio (distinct/instances) conflates 1 and 2 (the pool's ratio looks low). The
 * clean separator is distinctPerPage = distinct/pages: a BOUNDED vocabulary (chrome/label)
 * stays tiny per page; block content — even a reused pool — grows well past it. So classify
 * on distinctPerPage, using instances-per-page to split site-chrome (~1/pg) from a repeated
 * fixed LABEL (nav row, "Read more" — many/pg, same text).
 *
 * KNOWN & EXPECTED: a block's FIXED scaffolding (its "Read more" CTA, a section heading)
 * still lands in LABEL/CHROME — Step #2 (region assembly) reunites those with the VARYING
 * card content they sit next to. Step #1's job is to isolate varying content from chrome.
 */

const { descriptor, contentValue, loadPears } = require('./signature');

const runDir = process.argv[2] || 'test-run_grace_20260820231416/pairs';
const MIN_PAGES = 3;        // ignore one-off prose scatter
const CONTENT_DPP = 0.20;   // distinct-per-page >= this -> vocabulary grows -> content
const BOUNDED_DPP = 0.12;   // distinct-per-page <= this -> bounded vocabulary (chrome/label)
const PERPAGE_CHROME = 1.3; // <= this many instances/page -> once-per-page (site chrome)

const pears = loadPears(runDir);

const desc = new Map(); // key -> { pages:Set, count, values:Set, samples:Set, hasImg }
for (const p of pears) {
  for (const n of p.nodes) {
    const key = descriptor(n, p.nodes);
    let e = desc.get(key);
    if (!e) { e = { pages: new Set(), count: 0, values: new Set(), samples: new Set(), hasImg: key.includes('IMG') }; desc.set(key, e); }
    e.pages.add(p.url); e.count++;
    const v = contentValue(n);
    if (v) { e.values.add(v); if (e.samples.size < 4) e.samples.add(v.replace(/^https?:\/\/.*\//, '…/').slice(0, 42)); }
  }
}

const rows = [];
for (const [key, e] of desc) {
  const pages = e.pages.size;
  if (pages < MIN_PAGES) continue;
  const instances = e.count;
  const distinct = e.values.size;
  const vocabRatio = distinct / instances;
  const perPage = instances / pages;
  const distinctPerPage = distinct / pages;
  let bucket;
  if (distinctPerPage >= CONTENT_DPP) bucket = 'CONTENT';
  else if (distinctPerPage <= BOUNDED_DPP) bucket = perPage <= PERPAGE_CHROME ? 'CHROME' : 'LABEL';
  else bucket = 'AMBIG';
  rows.push({ key, pages, instances, distinct, vocabRatio, distinctPerPage, perPage, bucket, hasImg: e.hasImg, samples: [...e.samples] });
}

const byBucket = (b) => rows.filter((r) => r.bucket === b).sort((a, z) => z.instances - a.instances);
const counts = ['CONTENT', 'CHROME', 'LABEL', 'AMBIG'].map((b) => `${b}:${byBucket(b).length}`).join('   ');

console.log(`\n=== corpus: ${pears.length} pages, ${rows.length} recurring descriptors (>= ${MIN_PAGES} pages) ===`);
console.log(`=== buckets: ${counts} ===`);

function show(b, n) {
  console.log(`\n=== ${b} (top ${n} by instances) ${'='.repeat(40 - b.length)}`);
  for (const r of byBucket(b).slice(0, n)) {
    console.log(`  [${String(r.pages).padStart(3)}p x${String(r.instances).padStart(4)} · ${String(r.distinct).padStart(4)} distinct · dpp=${r.distinctPerPage.toFixed(2)} · ${r.perPage.toFixed(1)}/pg] ${r.hasImg ? '*IMG ' : ''}${r.key}`);
    if (r.samples.length) console.log(`        e.g. ${r.samples.map((s) => JSON.stringify(s)).join('  ')}`);
  }
}

show('CONTENT', 12);
show('CHROME', 10);
show('LABEL', 8);
show('AMBIG', 6);
console.log('');
