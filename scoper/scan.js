#!/usr/bin/env node
/*
 * Source-only site SCAN (issue #65). Scoping runs BEFORE any migration, so it needs to capture
 * pears from a list of source-only URLs (no target pairs). Thin, additive harness: reuses the
 * project's validated capture (anti-bot retries, stabilisation, overlay dismissal) READ-ONLY and
 * writes one source-clm.json per URL in the same layout the scoper reads, so scan output feeds
 * poc-regions.js / poc-catalog.js directly.
 *
 *   node scoper/scan.js <urls.csv> [outDir] [concurrency]
 *   then: node scoper/poc-catalog.js <outDir>/pairs
 *
 * urls.csv: one URL per line (first comma-field taken; blank / #-comment lines skipped).
 */

const fs = require('fs');
const path = require('path');
const { captureFullPageBuffer } = require('../lib/capture'); // read-only reuse; no lib edits

const urlsFile = process.argv[2];
if (!urlsFile) { console.error('usage: node scoper/scan.js <urls.csv> [outDir] [concurrency]'); process.exit(1); }
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outDir = process.argv[3] || `/private/tmp/claude-503/-Users-iustinp-github-qa-tool/16f2a38d-1803-4626-bab3-c6fbc8c70288/scratchpad/scan_${stamp}`;
const concurrency = parseInt(process.argv[4], 10) || 3;

const urls = fs.readFileSync(urlsFile, 'utf8').split(/\r?\n/)
  .map((l) => l.split(',')[0].trim())
  .filter((l) => l && !l.startsWith('#'));

const pairsDir = path.join(outDir, 'pairs');
fs.mkdirSync(pairsDir, { recursive: true });
const slug = (u, i) => `${String(i).padStart(4, '0')}-${(u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60))}`;

let done = 0, ok = 0, failed = 0;
async function scanOne(url, i) {
  const tag = `[${++done}/${urls.length}]`;
  try {
    // collectCanonicalLayout gates the pear extraction (off by default). dismissOverlays:false
    // skips the AI-based overlay dismissal (needs an API key we don't have for a pure scan); the
    // selector-based modal removal still runs.
    const { metadata, buffer } = await captureFullPageBuffer(url, { captureRole: 'page', collectCanonicalLayout: true, dismissOverlays: false });
    const clm = metadata && metadata.canonicalLayout;
    if (!clm || !Array.isArray(clm.nodes) || !clm.nodes.length) throw new Error('no canonical layout');
    if (!clm.url) clm.url = url;
    const dir = path.join(pairsDir, slug(url, i));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'source-clm.json'), JSON.stringify(clm));
    // full-page screenshot (pixel coords == document coords) as a review backdrop
    if (buffer) { fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true }); fs.writeFileSync(path.join(dir, 'screenshots', 'source-full.png'), buffer); }
    ok++; console.log(`${tag} ok   ${clm.nodes.length} nodes  ${url}`);
  } catch (e) {
    failed++; console.log(`${tag} FAIL ${e.message}  ${url}`);
  }
}

async function run() {
  console.log(`scanning ${urls.length} urls -> ${pairsDir} (concurrency ${concurrency})\n`);
  const queue = urls.map((u, i) => [u, i]);
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) { const [u, i] = queue.shift(); await scanOne(u, i); }
  });
  await Promise.all(workers);
  console.log(`\ndone: ${ok} ok, ${failed} failed -> ${pairsDir}`);
  console.log(`next: node scoper/poc-catalog.js ${pairsDir}`);
}
run();
