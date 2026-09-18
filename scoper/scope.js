#!/usr/bin/env node
/*
 * scoper/scope.js — END-TO-END scope run (issue #65): [scan] -> block inventory -> visual inventory.
 *
 *   node scoper/scope.js <urls.csv | pearsDir> [label] [concurrency]
 *
 *   - Given a .csv of source URLs   -> captures pears (scan) into ./scoper_<label>/, then analyzes.
 *   - Given a directory (a scan out dir, or its pairs/) -> skips scan, analyzes existing pears.
 *
 * Produces:
 *   <corpus>/inventory.json                     the ranked block-type inventory + counts
 *   ./scoper-run_visual-<label>_<ts>/index.html the visual inventory + correction UI (open it)
 *
 * Examples:
 *   node scoper/scope.js usta.csv usta 5        # scan usta.csv, then inventory + visual
 *   node scoper/scope.js scoper_usta usta       # re-analyze an already-scanned corpus (no re-scan)
 */

const fs = require('fs');
const path = require('path');
const { scan, readUrls } = require('./scan');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { buildInventory } = require('./inventory');
const { classifyPage } = require('./band-class');
const { buildVisual } = require('./visual');

function resolvePairs(dir) {
  return fs.existsSync(path.join(dir, 'pairs')) ? path.join(dir, 'pairs') : dir;
}

(async () => {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node scoper/scope.js <urls.csv | pearsDir> [label] [concurrency]');
    process.exit(1);
  }
  const isCsv = /\.csv$/i.test(input) || (fs.existsSync(input) && fs.statSync(input).isFile());
  const label = (process.argv[3] || path.basename(input).replace(/\.csv$/i, '')).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
  const concurrency = parseInt(process.argv[4], 10) || 4;
  const t0 = Date.now();

  let pairsDir;
  if (isCsv) {
    const urls = readUrls(input);
    console.log(`\n[1/3] scan — ${urls.length} urls (concurrency ${concurrency}) -> scoper_${label}/\n`);
    pairsDir = await scan(urls, `scoper_${label}`, concurrency);
  } else {
    pairsDir = resolvePairs(input);
    console.log(`\n[1/3] scan — skipped (using existing pears: ${pairsDir})`);
  }

  const pears = loadPears(pairsDir);
  if (!pears.length) { console.error(`no pears under ${pairsDir}`); process.exit(1); }

  console.log(`\n[2/3] inventory — ${pears.length} pages`);
  const { keyBucket } = classifyDescriptors(pears);
  const storePath = process.env.SCOPER_STORE || path.join(__dirname, 'store.json');
  const store = fs.existsSync(storePath) ? require('./store').loadStore(storePath) : null;
  if (store && Object.keys(store.types || {}).length) console.log(`  typing with learned store (${Object.keys(store.types).length} types) — ${storePath}`);
  // Human corrections applied as exact per-corpus overrides (SCOPER_CORRECTIONS = a corrections.json).
  let overrides = null;
  if (process.env.SCOPER_CORRECTIONS && fs.existsSync(process.env.SCOPER_CORRECTIONS)) {
    try { overrides = JSON.parse(fs.readFileSync(process.env.SCOPER_CORRECTIONS, 'utf8')); } catch { /* ignore bad file */ }
    if (overrides && Object.keys(overrides).length) console.log(`  applying ${Object.keys(overrides).length} correction override(s) — ${process.env.SCOPER_CORRECTIONS}`);
  }
  const inv = buildInventory(pears, keyBucket, { store, overrides });
  console.log(`\n${pears.length} pages · ${inv.length} distinct block types  (>=2 pages = the usable ones)\n`);
  console.log('   pp  inst  subtype                    signature');
  console.log('   --  ----  -------                    ---------');
  for (const b of inv) {
    console.log(`  ${String(b.pages).padStart(3)} ${String(b.instances).padStart(5)}  ${b.subtype.padEnd(24)} ${b.signature.slice(0, 60)}`);
  }
  fs.writeFileSync(path.join(path.dirname(pairsDir), 'inventory.json'),
    JSON.stringify({ pages: pears.length, blocks: inv.map(({ occurrences, ...b }) => b) }, null, 2));

  console.log(`\n[3/3] visual inventory + correction UI`);
  // When launched by the webui (/scoper), SCOPER_WEB carries the corpus path -> render the page in
  // server mode so its Analyze button POSTs to /api/scoper/analyze instead of exporting a file.
  const web = process.env.SCOPER_WEB;
  // Full per-page band list (block + default + chrome) so the visual can SHOW what the tool ignored.
  const allBands = {};
  for (const pg of pears) allBands[path.basename(pg.dir)] = classifyPage(pg, keyBucket, { store }).map((b) => ({ y0: b.y0, y1: b.y1, cls: b.cls, subtype: b.subtype }));
  const { outDir, cols, cropOk } = await buildVisual(inv, { label, perCol: 16, pages: pears.length, serverMode: !!web, corpus: web || '', allBands });

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✓ scope done in ${secs}s`);
  console.log(`  corpus:  ${pairsDir}`);
  console.log(`  visual:  ${path.join(outDir, 'index.html')}   (${cols} types · ${cropOk} crops)`);
  console.log(`  open it, or ask Claude to point the preview pane at it.\n`);
})().catch((e) => { console.error(e); process.exit(1); });
