#!/usr/bin/env node
/*
 * Step #1 probe — chrome vs content-block discriminator (issue #65).
 *
 * On a templated site, cross-page FREQUENCY can't separate site-chrome from a content
 * block (both recur on ~every page). The separator is VOCABULARY. There are THREE regimes:
 *   1. fixed/tiny   — chrome & fixed labels ("Read more", nav): a handful of values, never grow.
 *   2. bounded pool — "recent posts / related items" reuse a small POOL (~45) across pages.
 *   3. unbounded    — prose / dates: distinct grows with the corpus.
 * vocabRatio (distinct/instances) conflates 1 and 2; distinctPerPage (distinct/pages) does not:
 * bounded vocab (chrome/label) stays tiny per page, block content grows past it even if pooled.
 * Classification lives in ./chrome.js (shared with region assembly).
 *
 * KNOWN & EXPECTED: a block's FIXED scaffolding ("Read more", a section heading) lands in
 * LABEL/CHROME — step #2 (region assembly) reunites those with the varying card content.
 */

const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');

const runDir = process.argv[2] || 'test-run_grace_20260820231416/pairs';
const pears = loadPears(runDir);
const { rows } = classifyDescriptors(pears);
const recurring = rows.filter((r) => r.bucket !== 'RARE');

const byBucket = (b) => recurring.filter((r) => r.bucket === b).sort((a, z) => z.instances - a.instances);
const counts = ['CONTENT', 'CHROME', 'LABEL', 'AMBIG'].map((b) => `${b}:${byBucket(b).length}`).join('   ');

console.log(`\n=== corpus: ${pears.length} pages, ${recurring.length} recurring descriptors ===`);
console.log(`=== buckets: ${counts} ===`);

function show(b, n) {
  console.log(`\n=== ${b} (top ${n} by instances) ${'='.repeat(40 - b.length)}`);
  for (const r of byBucket(b).slice(0, n)) {
    console.log(`  [${String(r.pages).padStart(3)}p x${String(r.instances).padStart(4)} · ${String(r.distinct).padStart(4)} distinct · dpp=${r.distinctPerPage.toFixed(2)} · ${r.perPage.toFixed(1)}/pg] ${r.hasImg ? '*IMG ' : ''}${r.key}`);
    if (r.samples.length) console.log(`        e.g. ${r.samples.map((s) => JSON.stringify(s)).join('  ')}`);
  }
}

show('CONTENT', 12); show('CHROME', 10); show('LABEL', 8); show('AMBIG', 6);
console.log('');
