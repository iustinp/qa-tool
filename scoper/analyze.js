#!/usr/bin/env node
/*
 * scoper/analyze.js — consume exported corrections and update the learned store (issue #65, Step 2).
 *
 *   node scoper/analyze.js <corrections.json> <pearsDir> [storePath=scoper/store.json]
 *
 * Deterministic (no AI). For each correction (matched to its detected band by id, which is
 * basename(dir)_round(y0) — reproduced by re-running classifyPage on the same corpus):
 *   - correct   -> reinforce a positive exemplar of the detected type
 *   - reassign  -> positive exemplar of the new type
 *   - ➕ new     -> spawn the new type with the vector as its first prototype
 *   - ⧉ fragment-> NEGATIVE (context guard) on the detected type + positive exemplar(s) for the
 *                  drawn region's type (the two-signal model)
 * Each change is adapt-vs-spawn by vector distance; then the whole store is re-scored against ALL
 * accumulated corrections (the regression guard) and the number is reported.
 */

const fs = require('fs');
const path = require('path');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { classifyPage } = require('./band-class');
const { featureVector, nodesInBand, nodesInRect } = require('./features');
const { loadStore, saveStore, addExemplar, addNegative, scoreStore } = require('./store');

const corrFile = process.argv[2];
const pearsDir = process.argv[3];
const storePath = process.argv[4] || path.join(__dirname, 'store.json');
if (!corrFile || !pearsDir) { console.error('usage: node scoper/analyze.js <corrections.json> <pearsDir> [storePath]'); process.exit(1); }

const corrections = JSON.parse(fs.readFileSync(corrFile, 'utf8'));
const pears = loadPears(pearsDir);
if (!pears.length) { console.error(`no pears under ${pearsDir}`); process.exit(1); }
const { keyBucket } = classifyDescriptors(pears);

// id -> band geometry + page (ids reproduce the export's idOf = basename(dir)_round(y0))
const map = {};
for (const pg of pears) {
  const slug = path.basename(pg.dir);
  const shot = path.join(pg.dir, 'screenshots', 'source-full.png');
  let pngW = 0, pngH = 0;
  if (fs.existsSync(shot)) { const b = fs.readFileSync(shot); pngW = b.readUInt32BE(16); pngH = b.readUInt32BE(20); }
  const dpr = pg.dpr || 1;
  const pageW = Math.max(100, ...pg.nodes.map((n) => n.x + n.w), pngW / dpr);
  for (const b of classifyPage(pg, keyBucket)) {
    map[`${slug}_${Math.round(b.y0)}`] = { y0: b.y0, y1: b.y1, nodes: pg.nodes, pageW, pageWcss: pngW / dpr || pageW, pageHcss: pngH / dpr || Math.max(...pg.nodes.map((n) => n.y + n.h)) };
  }
}

const store = loadStore(storePath);
const before = scoreStore(store);
let applied = 0, skipped = 0;
const tally = { correct: 0, reassign: 0, new: 0, fragment: 0, region: 0 };

for (const [id, e] of Object.entries(corrections)) {
  const m = map[id];
  if (!m) { skipped++; console.warn(`  · no band for ${id} (wrong corpus?) — skipped`); continue; }
  const bandVec = featureVector(nodesInBand(m.nodes, m.y0, m.y1), m.pageW);
  const verdict = e.type || '';
  if (!verdict) { addExemplar(store, e.was, bandVec, { url: e.url, reason: e.reason, verdict: 'correct' }); store.corrections.push({ vec: bandVec, type: e.was, kind: 'pos', src: id }); tally.correct++; }
  else if (verdict === '__fragment__') { addNegative(store, e.was, bandVec, { url: e.url, reason: e.reason }); store.corrections.push({ vec: bandVec, srcType: e.was, kind: 'neg', src: id }); tally.fragment++; }
  else if (verdict === '__new__') { const n = e.newName || '(unnamed)'; addExemplar(store, n, bandVec, { url: e.url, reason: e.reason, characteristics: e.characteristics, verdict: 'new' }); store.corrections.push({ vec: bandVec, type: n, kind: 'pos', src: id }); tally.new++; }
  else { addExemplar(store, verdict, bandVec, { url: e.url, reason: e.reason, verdict: 'reassign', was: e.was }); store.corrections.push({ vec: bandVec, type: verdict, kind: 'pos', src: id }); tally.reassign++; }

  for (const r of (e.regions || [])) {
    const rect = { x: r.x * m.pageWcss, y: r.y * m.pageHcss, w: r.w * m.pageWcss, h: r.h * m.pageHcss };
    const regNodes = nodesInRect(m.nodes, rect);
    const rtype = r.type === '__new__' ? (r.newName || '(unnamed)') : r.type;
    if (!regNodes.length || !rtype) continue;
    addExemplar(store, rtype, featureVector(regNodes, m.pageW), { url: e.url, reason: r.reason, region: true });
    store.corrections.push({ vec: featureVector(regNodes, m.pageW), type: rtype, kind: 'pos', src: `${id}#region` });
    tally.region++;
  }
  applied++;
}

const after = scoreStore(store);
saveStore(storePath, store);

console.log(`\napplied ${applied} corrections (${skipped} skipped)`);
console.log(`  ${tally.correct} correct · ${tally.reassign} reassign · ${tally.new} new-type · ${tally.fragment} fragment · ${tally.region} region exemplars`);
console.log('\nstore types (prototypes / guards):');
for (const [type, t] of Object.entries(store.types).sort((a, b) => (b[1].prototypes.length) - (a[1].prototypes.length))) {
  console.log(`  ${String(t.prototypes.length).padStart(2)} proto · ${String((t.negatives || []).length)} guard   ${type}`);
}
console.log(`\nregression guard — train accuracy over ${after.n} accumulated corrections: ${(after.acc * 100).toFixed(0)}%  (was ${before.n ? (before.acc * 100).toFixed(0) + '%' : 'n/a'})`);
if (before.n && after.acc < before.acc) console.log('  ⚠ accuracy DROPPED — a change regressed earlier corrections; review before trusting the store.');
console.log(`\nstore -> ${storePath}`);
console.log('re-run  node scoper/scope.js <corpus>  to type with the updated store.\n');
