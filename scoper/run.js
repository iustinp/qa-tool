#!/usr/bin/env node
/*
 * Scope a source site and write a self-contained RUN directory into the project (like the main
 * project's test-run_* dirs), openable with no server — screenshots are embedded as data URIs.
 *
 *   node scoper/run.js <pearsDir> [label] [nSamples]
 *
 * pearsDir: a directory of <pair>/source-clm.json (from scoper/scan.js, or a main-project run).
 * Output: ./scoper-run_<label>_<timestamp>/  with index.html, catalog.html, regions.html,
 * catalog.json. Open index.html directly in a browser.
 */

const fs = require('fs');
const path = require('path');
const { loadPears } = require('./signature');
const { scope, regionsHtml, catalogHtml, attachCrops } = require('./report');

const pearsDir = process.argv[2];
if (!pearsDir) { console.error('usage: node scoper/run.js <pearsDir> [label] [nSamples]'); process.exit(1); }
const label = (process.argv[3] || 'scope').replace(/[^a-z0-9_-]+/gi, '-');
const nSamples = parseInt(process.argv[4], 10) || 10;

const pears = loadPears(pearsDir);
if (!pears.length) { console.error(`no source-clm.json pears under ${pearsDir}`); process.exit(1); }
const { perPage, catalog } = scope(pears);

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outDir = path.join(process.cwd(), `scoper-run_${label}_${ts}`);
fs.mkdirSync(outDir, { recursive: true });

main().catch((e) => { console.error(e); process.exit(1); });
async function main() {
await attachCrops(catalog); // real screenshot crop per catalog block

fs.writeFileSync(path.join(outDir, 'catalog.html'), catalogHtml(catalog, { pages: pears.length }));
fs.writeFileSync(path.join(outDir, 'regions.html'), regionsHtml(perPage, { nSamples, title: `${label} regions` }));

// slim, machine-readable catalog (no node arrays)
const slim = catalog.map((b, i) => ({ rank: i + 1, type: b.type, isCollection: b.isCollection, pageCount: b.pageCount, instances: b.instances, maxRepeat: b.maxRepeat, signature: b.key, exampleUrl: b.example && b.example.url, samples: b.samples.slice(0, 6) }));
fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify({ pearsDir, pages: pears.length, blocks: slim }, null, 2));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rows = slim.filter((b) => b.pageCount >= 2).map((b) => `<tr><td>${b.rank}</td><td><b>${esc(b.type)}</b></td><td>${b.pageCount}</td><td>${b.instances}</td><td>${b.isCollection ? '✓' : ''}</td><td class="sig">${esc(b.signature)}</td></tr>`).join('');
fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html><meta charset="utf8"><title>scoper run — ${esc(label)}</title>
<style>body{font:14px system-ui;margin:24px;color:#1c1c1c} a.big{display:inline-block;margin:0 12px 16px 0;padding:8px 14px;background:#1a9e6a;color:#fff;border-radius:6px;text-decoration:none}
table{border-collapse:collapse;margin-top:10px;font-size:13px} td,th{border:1px solid #e2e2e2;padding:4px 8px;text-align:left} th{background:#f4f4f4}
.sig{font-family:ui-monospace,monospace;font-size:11px;color:#1a7} h1{font-size:18px}</style>
<h1>scoper run — ${esc(label)}</h1>
<p>${pears.length} pages · ${rows ? slim.filter((b) => b.pageCount >= 2).length : 0} recurring block types · ${esc(pearsDir)}</p>
<a class="big" href="catalog.html">Block catalog →</a><a class="big" href="regions.html">Region overlays →</a>
<table><tr><th>#</th><th>EDS type (guess)</th><th>pages</th><th>inst</th><th>coll</th><th>signature</th></tr>${rows}</table>`);

console.log(`\nscoper run -> ${outDir}`);
console.log(`  open: ${path.join(outDir, 'index.html')}`);
console.log(`  ${pears.length} pages, ${catalog.filter((b) => b.pageCount >= 2).length} recurring block types\n`);
}
