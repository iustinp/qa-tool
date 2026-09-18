#!/usr/bin/env node
/*
 * PoC 1 — neighborhood-descriptor recurrence (issue #65).
 *
 * Offline, deterministic, no AI. Tests the linchpin: a reusable block shows up as a
 * recurring, content-blind neighborhood descriptor, while one-off prose scatters into
 * near-unique ones. Descriptor + loader live in ./signature.js (shared across steps).
 */

const { descriptor, loadPears } = require('./signature');

const runDir = process.argv[2] || 'test-run_grace_20260820231416/pairs';
const pears = loadPears(runDir);

const desc = new Map(); // key -> { pages:Set, count, samples:[], hasImg }
let totalNodes = 0;
for (const p of pears) {
  totalNodes += p.nodes.length;
  for (const n of p.nodes) {
    const key = descriptor(n, p.nodes);
    let e = desc.get(key);
    if (!e) { e = { pages: new Set(), count: 0, samples: [], hasImg: key.includes('IMG') }; desc.set(key, e); }
    e.pages.add(p.url); e.count++;
    if (e.samples.length < 4 && n.kind === 'text' && n.text) e.samples.push(n.text.slice(0, 40));
  }
}

const entries = [...desc.entries()].map(([key, e]) => ({ key, pages: e.pages.size, count: e.count, hasImg: e.hasImg, samples: e.samples }));
const nPages = pears.length;

console.log(`\n=== corpus =========================================================`);
console.log(`pages: ${nPages}   nodes: ${totalNodes} (${(totalNodes / nPages).toFixed(0)}/page)   distinct descriptors: ${entries.length}`);

const bins = { '1': 0, '2-4': 0, '5-20': 0, '21-99': 0, '100+': 0 };
for (const e of entries) {
  const p = e.pages;
  if (p === 1) bins['1']++; else if (p <= 4) bins['2-4']++; else if (p <= 20) bins['5-20']++; else if (p < 100) bins['21-99']++; else bins['100+']++;
}
console.log(`\n=== descriptor recurrence (how many pages a descriptor appears on) ==`);
for (const k of Object.keys(bins)) console.log(`  on ${k.padEnd(6)} pages : ${bins[k]} descriptors`);
console.log(`  -> ${(bins['1'] / entries.length * 100).toFixed(0)}% of descriptors are page-unique (prose should land here)`);

function show(list, n) {
  for (const e of list.slice(0, n)) {
    console.log(`  [${String(e.pages).padStart(3)}p x${String(e.count).padStart(4)}] ${e.hasImg ? '*IMG ' : '     '}${e.key}`);
    if (e.samples.length) console.log(`         e.g. ${e.samples.map((s) => JSON.stringify(s)).join('  ')}`);
  }
}

const byPages = [...entries].sort((a, b) => b.pages - a.pages || b.count - a.count);
console.log(`\n=== top 20 descriptors by cross-page recurrence =====================`);
show(byPages, 20);
console.log(`\n=== top 15 IMAGE-adjacent descriptors (card/hero/teaser candidates) =`);
show(byPages.filter((e) => e.hasImg), 15);
console.log('');
