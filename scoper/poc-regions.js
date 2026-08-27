#!/usr/bin/env node
/*
 * Step #2 runner (issue #65): assemble regions across the corpus, print a compact summary,
 * and render a VISUAL HTML per sample page (pear text with detected regions boxed + labelled)
 * so the result is actually legible. Offline, deterministic.
 *
 *   node scoper/poc-regions.js [runDir] [numSamplePages]
 */

const fs = require('fs');
const path = require('path');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { assembleRegions } = require('./regions');

const runDir = process.argv[2] || 'test-run_grace_20260820231416/pairs';
const nSamples = parseInt(process.argv[3], 10) || 3;
const outDir = process.env.SCOPER_OUT || '/private/tmp/claude-503/-Users-iustinp-github-qa-tool/16f2a38d-1803-4626-bab3-c6fbc8c70288/scratchpad';

const pears = loadPears(runDir);
const { keyBucket } = classifyDescriptors(pears);

// ---- corpus summary --------------------------------------------------------
const tally = { chrome: 0, block: 0, prose: 0, minor: 0 };
let totalRegions = 0;
const perPage = [];
for (const p of pears) {
  const regions = assembleRegions(p.nodes, keyBucket);
  perPage.push({ url: p.url, nodes: p.nodes, regions });
  for (const r of regions) { tally[r.type]++; totalRegions++; }
}
console.log(`\n=== corpus: ${pears.length} pages, ${totalRegions} regions (${(totalRegions / pears.length).toFixed(1)}/page) ===`);
for (const k of Object.keys(tally)) console.log(`  ${k.padEnd(7)}: ${tally[k]}`);

// most common BLOCK signatures across pages (a preview of the step #3 catalog)
const blockSig = new Map();
for (const pg of perPage) for (const r of pg.regions) if (r.type === 'block') {
  const e = blockSig.get(r.signature) || { pages: new Set(), count: 0, ex: r };
  e.pages.add(pg.url); e.count++; blockSig.set(r.signature, e);
}
console.log(`\n=== most recurrent BLOCK region signatures (preview of #3 catalog) ===`);
for (const [sig, e] of [...blockSig].sort((a, z) => z[1].pages.size - a[1].pages.size).slice(0, 12)) {
  console.log(`  [${String(e.pages.size).padStart(3)}p x${String(e.count).padStart(4)}] ${sig}`);
}

// ---- visual render ---------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLOR = { chrome: '#8a94a6', block: '#1a9e6a', prose: '#3b76d1', minor: '#c2c2c2' };

function renderPage(pg, scale) {
  const pageW = Math.max(...pg.nodes.map((n) => n.x + n.w), 100);
  const pageH = Math.max(...pg.nodes.map((n) => n.y + n.h), 100);
  const S = scale;
  const parts = [];
  parts.push(`<div class="page" style="width:${(pageW * S).toFixed(0)}px;height:${(pageH * S).toFixed(0)}px">`);
  // region boxes (behind)
  for (const r of pg.regions) {
    if (r.type === 'minor') continue;
    const c = COLOR[r.type];
    parts.push(`<div class="rg" style="left:${(r.x * S).toFixed(0)}px;top:${(r.y * S).toFixed(0)}px;width:${(r.w * S).toFixed(0)}px;height:${(r.h * S).toFixed(0)}px;border-color:${c}">`);
    parts.push(`<span class="tag" style="background:${c}">${r.type} · ${esc(r.signature).slice(0, 60)}</span></div>`);
  }
  // nodes (front, faint)
  for (const n of pg.nodes) {
    if (n.kind === 'text') {
      parts.push(`<div class="tx" style="left:${(n.x * S).toFixed(0)}px;top:${(n.y * S).toFixed(0)}px;width:${(n.w * S).toFixed(0)}px;height:${(n.h * S).toFixed(0)}px;font-size:${Math.max(6, n.fontSize * S).toFixed(0)}px;font-weight:${esc(n.fontWeight)}">${esc(n.text || '')}</div>`);
    } else {
      parts.push(`<div class="im" style="left:${(n.x * S).toFixed(0)}px;top:${(n.y * S).toFixed(0)}px;width:${(n.w * S).toFixed(0)}px;height:${(n.h * S).toFixed(0)}px">img</div>`);
    }
  }
  const counts = pg.regions.reduce((m, r) => (m[r.type] = (m[r.type] || 0) + 1, m), {});
  parts.push(`</div>`);
  return `<h3>${esc(pg.url)}</h3><p class="cnt">regions — block:${counts.block || 0} chrome:${counts.chrome || 0} prose:${counts.prose || 0} minor:${counts.minor || 0}</p>` + parts.join('');
}

const scale = 900 / Math.max(...perPage[0].nodes.map((n) => n.x + n.w), 900);
const body = perPage.slice(0, nSamples).map((pg) => renderPage(pg, scale)).join('<hr>');
const html = `<!doctype html><meta charset="utf8"><title>scoper regions</title>
<style>
 body{font:13px system-ui;margin:20px;color:#222}
 .legend span{display:inline-block;padding:2px 8px;margin-right:6px;border-radius:3px;color:#fff}
 .page{position:relative;border:1px solid #eee;margin:8px 0 28px;background:#fff}
 .rg{position:absolute;border:2px solid;border-radius:3px;box-sizing:border-box}
 .rg .tag{position:absolute;left:-1px;top:-16px;font-size:10px;color:#fff;padding:1px 5px;border-radius:3px;white-space:nowrap;font-family:ui-monospace,monospace}
 .tx{position:absolute;color:#3a3a3a;overflow:hidden;white-space:nowrap;line-height:1}
 .im{position:absolute;background:#f0ede6;border:1px dashed #b7ad97;color:#b7ad97;font-size:9px;text-align:center;box-sizing:border-box}
 h3{margin:24px 0 2px;font-size:13px;color:#555;word-break:break-all}
 .cnt{margin:0 0 6px;color:#888;font-family:ui-monospace,monospace}
 hr{border:0;border-top:1px dashed #ddd;margin:30px 0}
</style>
<h2>scoper — detected regions (issue #65, step #2)</h2>
<p class="legend">
 <span style="background:${COLOR.block}">block (EDS block candidate)</span>
 <span style="background:${COLOR.chrome}">chrome (site frame)</span>
 <span style="background:${COLOR.prose}">prose (default content)</span>
 <span style="background:${COLOR.minor}">minor</span>
</p>
<p>${pears.length} pages analysed · showing first ${nSamples}. Box = a detected region; label = type + content-blind signature.</p>
${body}`;

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'scoper-regions.html');
fs.writeFileSync(outFile, html);
console.log(`\nvisual: ${outFile}\n`);
