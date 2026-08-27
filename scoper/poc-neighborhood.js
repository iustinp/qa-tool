#!/usr/bin/env node
/*
 * PoC 1 — neighborhood-descriptor recurrence (issue #65).
 *
 * Offline, deterministic, no AI. Reads existing source pears (source-clm.json) from a run
 * directory and tests the linchpin hypothesis: a reusable block shows up as a *recurring,
 * content-blind neighborhood descriptor*, while one-off prose scatters into near-unique ones.
 *
 * A descriptor = own style-token  +  {direction : style-token} of the K nearest neighbours,
 * where a style-token abstracts a node to its ROLE (kind + size tier + weight + case/align),
 * never its text/image content, and a direction is the ordinal (N/S/E/W) of the neighbour's
 * ORIGIN relative to this node's origin. No absolute pixel distances enter the key -> elastic
 * to content-length variation; per-site consistency -> no cross-site normalisation needed yet.
 */

const fs = require('fs');
const path = require('path');

const K = 3;                       // nearest neighbours per node
const runDir = process.argv[2] || 'test-run_grace_20260820231416/pairs';

// ---- style token (content-blind role of a single node) --------------------
function sizeBucket(fs_) { return Math.round((fs_ || 0) / 2) * 2; }         // light px quantise
function weightBucket(fw) { const n = parseInt(fw, 10); return (n >= 600 || fw === 'bold') ? 'b' : 'r'; }
function alignBucket(a) { return a === 'center' ? 'c' : (a === 'right' || a === 'end') ? 'r' : 'l'; }
function aspectBucket(w, h) {
  const ar = w / Math.max(1, h);
  return ar > 2 ? 'wide' : ar < 0.6 ? 'tall' : ar > 1.3 ? 'land' : ar < 0.8 ? 'port' : 'sq';
}
function styleToken(n) {
  if (n.kind === 'text') {
    const up = n.textTransform === 'uppercase' ? 'U' : '';
    const it = n.fontStyle && n.fontStyle !== 'normal' ? 'I' : '';
    return `T${sizeBucket(n.fontSize)}${weightBucket(n.fontWeight)}${up}${it}${alignBucket(n.align)}`;
  }
  if (n.kind === 'image' || n.kind === 'bg-image') return `IMG-${aspectBucket(n.w, n.h)}`;
  return 'X';
}

// ---- ordinal direction from node a's origin to node b's origin ------------
function dir(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 'S' : 'N';   // below / above
  return dx > 0 ? 'E' : 'W';                                     // right / left
}
function d2(a, b) { const dx = b.x - a.x, dy = b.y - a.y; return dx * dx + dy * dy; }

function descriptor(node, all) {
  const own = styleToken(node);
  const nb = all
    .filter((n) => n !== node)
    .sort((p, q) => d2(node, p) - d2(node, q))
    .slice(0, K)
    .map((n) => `${dir(node, n)}:${styleToken(n)}`)
    .sort();                                                     // order-independent key
  return `${own}|${nb.join(',')}`;
}

// ---- load corpus -----------------------------------------------------------
const pairDirs = fs.readdirSync(runDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(runDir, d.name));

const pears = [];
for (const dir_ of pairDirs) {
  const f = path.join(dir_, 'source-clm.json');
  if (!fs.existsSync(f)) continue;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(j.nodes) && j.nodes.length) pears.push({ url: j.url || dir_, nodes: j.nodes });
  } catch { /* skip unreadable */ }
}

// ---- accumulate descriptors across pages ----------------------------------
const desc = new Map(); // key -> { pages:Set<url>, count, samples:[{text,tok}], hasImg }
let totalNodes = 0;
for (const p of pears) {
  const nodes = p.nodes;
  totalNodes += nodes.length;
  for (const n of nodes) {
    const key = descriptor(n, nodes);
    let e = desc.get(key);
    if (!e) { e = { pages: new Set(), count: 0, samples: [], hasImg: key.includes('IMG') }; desc.set(key, e); }
    e.pages.add(p.url);
    e.count++;
    if (e.samples.length < 4 && n.kind === 'text' && n.text) e.samples.push(n.text.slice(0, 40));
  }
}

const entries = [...desc.entries()].map(([key, e]) => ({ key, pages: e.pages.size, count: e.count, hasImg: e.hasImg, samples: e.samples }));
const nPages = pears.length;

// ---- report ----------------------------------------------------------------
console.log(`\n=== corpus =========================================================`);
console.log(`pages: ${nPages}   nodes: ${totalNodes} (${(totalNodes / nPages).toFixed(0)}/page)   distinct descriptors: ${entries.length}`);

const bins = { '1': 0, '2-4': 0, '5-20': 0, '21-99': 0, '100+': 0 };
for (const e of entries) {
  const p = e.pages;
  if (p === 1) bins['1']++; else if (p <= 4) bins['2-4']++; else if (p <= 20) bins['5-20']++; else if (p < 100) bins['21-99']++; else bins['100+']++;
}
console.log(`\n=== descriptor recurrence (how many pages a descriptor appears on) ==`);
for (const k of Object.keys(bins)) console.log(`  on ${k.padEnd(6)} pages : ${bins[k]} descriptors`);
const uniqueFrac = (bins['1'] / entries.length * 100).toFixed(0);
console.log(`  -> ${uniqueFrac}% of descriptors are page-unique (prose should land here)`);

function show(list, n) {
  for (const e of list.slice(0, n)) {
    console.log(`  [${String(e.pages).padStart(3)}p x${String(e.count).padStart(4)}] ${e.hasImg ? '*IMG ' : '     '}${e.key}`);
    if (e.samples.length) console.log(`         e.g. ${e.samples.map((s) => JSON.stringify(s)).join('  ')}`);
  }
}

const byPages = [...entries].sort((a, b) => b.pages - a.pages || b.count - a.count);
console.log(`\n=== top 20 descriptors by cross-page recurrence =====================`);
show(byPages, 20);

const blockish = byPages.filter((e) => e.hasImg);
console.log(`\n=== top 15 IMAGE-adjacent descriptors (card/hero/teaser candidates) =`);
show(blockish, 15);
console.log('');
