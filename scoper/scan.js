#!/usr/bin/env node
/*
 * Source-only site SCAN (issue #65). Scoping runs BEFORE any migration, so it captures pears from a
 * list of source-only URLs (no target pairs). Thin, additive harness: reuses the project's validated
 * capture (anti-bot retries, stabilisation) READ-ONLY and writes one source-clm.json (+ screenshot)
 * per URL in the layout the scoper reads.
 *
 *   node scoper/scan.js <urls.csv> [outDir] [concurrency]
 *   then: node scoper/scope.js <outDir>        (inventory + visual)
 *
 * Also exported as { scan, readUrls } so scoper/scope.js can run it end-to-end.
 * urls.csv: one URL per line (first comma-field taken; blank / #-comment lines skipped).
 */

const fs = require('fs');
const path = require('path');
const { captureFullPageBuffer } = require('../lib/capture'); // read-only reuse; no lib edits

const slug = (u, i) => `${String(i).padStart(4, '0')}-${(u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60))}`;

function readUrls(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.split(',')[0].trim())
    .filter((l) => l && !l.startsWith('#'));
}

// Capture pears for `urls` into <outDir>/pairs/<slug>/source-clm.json (+ screenshots/source-full.png).
// Returns the pairs dir. collectCanonicalLayout gates pear extraction; dismissOverlays:false skips the
// AI overlay dismissal (no API key needed for a pure scan) — selector-based modal removal still runs.
async function scan(urls, outDir, concurrency = 3) {
  const pairsDir = path.join(outDir, 'pairs');
  fs.mkdirSync(pairsDir, { recursive: true });
  let done = 0, ok = 0, failed = 0;
  const queue = urls.map((u, i) => [u, i]);

  async function scanOne(url, i) {
    const tag = `[${++done}/${urls.length}]`;
    try {
      const { metadata, buffer } = await captureFullPageBuffer(url, { captureRole: 'page', collectCanonicalLayout: true, dismissOverlays: false });
      const clm = metadata && metadata.canonicalLayout;
      if (!clm || !Array.isArray(clm.nodes) || !clm.nodes.length) throw new Error('no canonical layout');
      if (!clm.url) clm.url = url;
      const dir = path.join(pairsDir, slug(url, i));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'source-clm.json'), JSON.stringify(clm));
      if (buffer) { fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true }); fs.writeFileSync(path.join(dir, 'screenshots', 'source-full.png'), buffer); }
      ok++; console.log(`${tag} ok   ${clm.nodes.length} nodes  ${url}`);
    } catch (e) {
      failed++; console.log(`${tag} FAIL ${e.message}  ${url}`);
    }
  }

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) { const [u, i] = queue.shift(); await scanOne(u, i); }
  });
  await Promise.all(workers);
  console.log(`\nscan done: ${ok} ok, ${failed} failed -> ${pairsDir}`);
  return pairsDir;
}

module.exports = { scan, readUrls };

if (require.main === module) {
  const urlsFile = process.argv[2];
  if (!urlsFile) { console.error('usage: node scoper/scan.js <urls.csv> [outDir] [concurrency]'); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outDir = process.argv[3] || `scoper_scan_${stamp}`;
  const concurrency = parseInt(process.argv[4], 10) || 3;
  scan(readUrls(urlsFile), outDir, concurrency)
    .then(() => console.log(`next: node scoper/scope.js ${outDir}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
