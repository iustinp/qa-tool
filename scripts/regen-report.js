#!/usr/bin/env node
'use strict';

/**
 * Regenerate report.html for an already-completed run, from its summary.json —
 * without re-running the pipeline. Useful after report-layout improvements.
 *
 *   node scripts/regen-report.js <run-dir> [<run-dir> ...]
 *
 * summary.json already stores both URLs and every score per pair, so the report
 * is rebuilt with the current generator (lib/score-report.js) using only that file.
 */
const fs = require('fs');
const path = require('path');
const { writeScoreReport } = require('../lib/score-report');

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('usage: node scripts/regen-report.js <run-dir> [<run-dir> ...]');
  process.exit(1);
}

for (const dir of dirs) {
  const summaryPath = path.join(dir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    console.error(`skip ${dir}: no summary.json`);
    continue;
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const rows = summary.results || [];
  const generatedAt = (summary.generatedAt || summary.finishedAt || summary.startedAt || '')
    ? `${summary.generatedAt || summary.finishedAt || summary.startedAt} (report regenerated ${new Date().toISOString()})`
    : `report regenerated ${new Date().toISOString()}`;
  const p = writeScoreReport(dir, rows, { pairCount: rows.length, generatedAt });
  console.log(`wrote ${p} (${rows.length} pairs)`);
}
