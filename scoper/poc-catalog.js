#!/usr/bin/env node
/*
 * Step #3 runner (issue #65): build the cross-page block catalog and render a SCOPING REPORT
 * (each discovered block type: reach + type guess + a rendered example instance). Offline.
 *
 *   node scoper/poc-catalog.js [runDir]
 */

const fs = require('fs');
const path = require('path');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { assembleRegions } = require('./regions');
const { buildCatalog } = require('./catalog');

const runDir = process.argv[2] || 'test-run_grace_20260820231416/pairs';
const outDir = process.env.SCOPER_OUT || '/private/tmp/claude-503/-Users-iustinp-github-qa-tool/16f2a38d-1803-4626-bab3-c6fbc8c70288/scratchpad';

const pears = loadPears(runDir);
const { keyBucket } = classifyDescriptors(pears);
const perPage = pears.map((p) => ({ url: p.url, regions: assembleRegions(p.nodes, keyBucket) }));
const catalog = buildCatalog(perPage);

// ---- text summary ----------------------------------------------------------
console.log(`\n=== BLOCK CATALOG — ${pears.length} pages, ${catalog.length} distinct block units ===\n`);
console.log('  rank  pages  inst  coll  type                    unit signature');
catalog.slice(0, 20).forEach((b, i) => {
  console.log(`  ${String(i + 1).padStart(3)}  ${String(b.pageCount).padStart(5)}  ${String(b.instances).padStart(4)}   ${b.isCollection ? '✓' : ' '}   ${b.type.padEnd(22)}  ${b.key.slice(0, 44)}`);
});

// ---- scoping report (visual) ----------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function thumb(example, maxW = 340) {
  const rn = example.region.nodes;
  const ox = Math.min(...rn.map((n) => n.x)), oy = Math.min(...rn.map((n) => n.y));
  const w = example.region.w, h = example.region.h;
  const S = Math.min(maxW / Math.max(w, 1), 0.5);
  const parts = [`<div class="th" style="width:${(w * S).toFixed(0)}px;height:${(h * S).toFixed(0)}px">`];
  for (const n of rn) {
    const l = ((n.x - ox) * S).toFixed(0), t = ((n.y - oy) * S).toFixed(0), nw = (n.w * S).toFixed(0), nh = (n.h * S).toFixed(0);
    if (n.kind === 'text') parts.push(`<div class="tx" style="left:${l}px;top:${t}px;width:${nw}px;height:${nh}px;font-size:${Math.max(6, n.fontSize * S).toFixed(0)}px;font-weight:${esc(n.fontWeight)}">${esc(n.text || '')}</div>`);
    else parts.push(`<div class="im" style="left:${l}px;top:${t}px;width:${nw}px;height:${nh}px">img</div>`);
  }
  parts.push('</div>');
  return parts.join('');
}

const blocks = catalog.filter((b) => b.pageCount >= 2);
const cards = blocks.map((b, i) => `
  <div class="card">
    <div class="hd"><span class="rk">#${i + 1}</span><span class="ty">${esc(b.type)}</span>${b.isCollection ? '<span class="cl">collection</span>' : ''}</div>
    <div class="st">${b.pageCount} pages · ${b.instances} instances${b.maxRepeat > 1 ? ` · up to ${b.maxRepeat}× repeat` : ''}</div>
    <div class="sig">${esc(b.key)}</div>
    ${thumb(b.example)}
    <div class="sm">${b.samples.slice(0, 4).map((s) => esc(s)).join(' · ')}</div>
  </div>`).join('');

const html = `<!doctype html><meta charset="utf8"><title>scoper — block catalog</title>
<style>
 body{font:13px system-ui;margin:22px;color:#1c1c1c;background:#fafafa}
 h2{margin:0 0 4px} .lead{color:#666;margin:0 0 18px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px}
 .card{background:#fff;border:1px solid #e6e6e6;border-radius:8px;padding:12px 14px}
 .hd{display:flex;align-items:center;gap:8px;margin-bottom:2px}
 .rk{color:#999;font-family:ui-monospace,monospace;font-size:12px}
 .ty{font-weight:600;font-size:15px}
 .cl{background:#1a9e6a;color:#fff;font-size:10px;padding:1px 7px;border-radius:10px}
 .st{color:#555;font-size:12px;margin-bottom:4px}
 .sig{font-family:ui-monospace,monospace;font-size:11px;color:#1a9e6a;background:#f2faf6;border:1px solid #d6efe3;border-radius:4px;padding:3px 6px;margin-bottom:10px;word-break:break-all}
 .th{position:relative;border:1px solid #eee;background:#fff;margin:0 auto 8px}
 .th .tx{position:absolute;color:#333;overflow:hidden;white-space:nowrap;line-height:1}
 .th .im{position:absolute;background:#f0ede6;border:1px dashed #b7ad97;color:#b7ad97;font-size:8px;text-align:center;box-sizing:border-box}
 .sm{color:#888;font-size:11px;border-top:1px dashed #eee;padding-top:6px}
</style>
<h2>scoper — source block catalog</h2>
<p class="lead">${pears.length} pages · ${blocks.length} recurring block types discovered (deterministic, no AI). Ranked by reach. Type = algorithmic guess; signature = content-blind repeating unit; example = one real instance.</p>
<div class="grid">${cards}</div>`;

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'scoper-catalog.html');
fs.writeFileSync(outFile, html);
console.log(`\nscoping report: ${outFile}\n`);
