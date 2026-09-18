#!/usr/bin/env node
/*
 * scoper/learn.js — LEARNING MODE end-to-end (issue #65, Step 3): scan -> oracle -> align -> analyze.
 *
 *   node scoper/learn.js <eds-urls.csv | corpusDir> [label] [concurrency]
 *
 * Feed it a CSV of already-migrated EDS pages (.aem.page / .aem.live). It scans them into pears exactly
 * like a normal run, then captures the EDS DOM as GROUND TRUTH (eds-oracle.js), grades detection against
 * it + emits a scorecard and auto-corrections (align.js), and finally LEARNS from those auto-corrections
 * (analyze.js) — the same engine a human review feeds, but the feedback comes from the DOM oracle.
 *
 * Pass a corpusDir instead of a CSV to re-run oracle+align+analyze on an already-scanned corpus.
 * SCOPER_STORE overrides the store path; SCOPER_LEARN_NOAPPLY=1 stops before analyze (grade only).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scan, readUrls } = require('./scan');
const { captureOracle } = require('./eds-oracle');
const { alignCorpus, printScorecard } = require('./align');

function resolvePairs(dir) { return fs.existsSync(path.join(dir, 'pairs')) ? path.join(dir, 'pairs') : dir; }

(async () => {
  const input = process.argv[2];
  if (!input) { console.error('usage: node scoper/learn.js <eds-urls.csv | corpusDir> [label] [concurrency]'); process.exit(1); }
  const isCsv = /\.csv$/i.test(input) || (fs.existsSync(input) && fs.statSync(input).isFile());
  const label = (process.argv[3] || path.basename(input).replace(/\.csv$/i, '')).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
  const concurrency = parseInt(process.argv[4], 10) || 4;
  const storePath = process.env.SCOPER_STORE || path.join(__dirname, 'store.json');

  let corpusDir;
  if (isCsv) {
    const urls = readUrls(input);
    console.log(`\n[1/4] scan — ${urls.length} EDS urls -> scoper_${label}/`);
    const pairsDir = await scan(urls, `scoper_${label}`, concurrency);
    corpusDir = path.dirname(pairsDir);
  } else {
    corpusDir = input;
    console.log(`\n[1/4] scan — skipped (using existing corpus: ${corpusDir})`);
  }

  console.log(`\n[2/4] oracle — capturing EDS ground-truth DOM`);
  const o = await captureOracle(corpusDir, { concurrency });
  if (!o.blocks) { console.error('\n✕ no ground-truth blocks captured — are these EDS pages, and reachable headless?'); process.exit(1); }

  console.log(`\n[3/4] align — grading detection against ground-truth`);
  const { scorecard, corrections } = alignCorpus(corpusDir, { storePath });
  const outBase = corpusDir;
  const corrPath = path.join(outBase, 'eds-corrections.json');
  fs.writeFileSync(path.join(outBase, 'scorecard.json'), JSON.stringify(scorecard, null, 2));
  fs.writeFileSync(corrPath, JSON.stringify(corrections, null, 2));
  printScorecard(scorecard);

  if (process.env.SCOPER_LEARN_NOAPPLY) { console.log('SCOPER_LEARN_NOAPPLY set — graded only, not learning.\n'); return; }

  console.log(`[4/4] analyze — learning from ${Object.keys(corrections).length} auto-correction entries`);
  execFileSync('node', [path.join(__dirname, 'analyze.js'), corrPath, resolvePairs(corpusDir), storePath], { stdio: 'inherit' });
  console.log(`\n✓ learning pass complete. Re-run the scorecard to see the needle move:`);
  console.log(`   node scoper/align.js ${corpusDir} ${storePath}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
