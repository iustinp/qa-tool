#!/usr/bin/env node
/*
 * scoper/eds-oracle.js — GROUND-TRUTH capture for LEARNING MODE (issue #65, Step 3).
 *
 *   node scoper/eds-oracle.js <corpusDir> [concurrency]
 *
 * FENCED, LEARNING-ONLY DOM read. An EDS page has a KNOWN, clean contract:
 *
 *     main > div (section) > div.<blockname>        (a block; name = data-block-name / first class)
 *     main > div (section) > div  (no block class)  (default-content wrapper — imports at ~0 effort)
 *
 * so the DOM is a free ORACLE: it tells us the TRUE block type and TRUE band boundaries for a page we
 * already scanned as pears. This is NOT detection — detection stays pear/screenshot-based and NEVER
 * imports this file. The oracle is used ONLY to grade + teach (scoper/align.js turns overlaps into the
 * same correction vocabulary a human draws). Because it re-visits the SAME urls a scan already captured
 * and emits boxes in the IDENTICAL coordinate space (getBoundingClientRect + scroll, at scrollTop=0, no
 * dpr), a block box's y-range aligns directly with an occurrence's y0/y1.
 *
 * Writes, next to each scanned pear:  <corpusDir>/pairs/<slug>/eds-oracle.json
 *   { url, width, height, dpr, blocks:[{name,variant[],section,x,y,w,h}], defaults:[{section,x,y,w,h}] }
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function resolvePairs(dir) {
  return fs.existsSync(path.join(dir, 'pairs')) ? path.join(dir, 'pairs') : dir;
}

// Map every scanned pear's url -> its pair dir (so we write the oracle beside the right pears, and only
// for pages the scan actually captured). Reading source-clm.json.url avoids re-deriving scan.js's slug.
function urlToDir(pairsDir) {
  const map = new Map();
  for (const d of fs.readdirSync(pairsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(pairsDir, d.name, 'source-clm.json');
    if (!fs.existsSync(f)) continue;
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.url) map.set(j.url, path.join(pairsDir, d.name)); } catch { /* skip */ }
  }
  return map;
}

// The in-browser walk. Runs at scrollTop=0 so rect+scroll matches the CLM node coordinate space exactly.
// EDS decorated markup is:  main > div.section > div.<name>-wrapper > div.<name>.block[data-block-name]
// — the block sits one level below the section (inside a *-wrapper), so we select decorated blocks
// DIRECTLY ([data-block-name] / div.block) and derive each one's section by walking up to main. Default
// content is the `default-content-wrapper` divs (headings/paras/lists that import at ~0 effort).
/* eslint-disable */
function walkEds() {
  const main = document.querySelector('main');
  const doc = document.documentElement;
  const base = { url: location.href, width: doc.scrollWidth, height: doc.scrollHeight, dpr: window.devicePixelRatio || 1, blocks: [], defaults: [] };
  if (!main) return base;
  const sx = window.scrollX, sy = window.scrollY;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sections = Array.prototype.filter.call(main.children, (el) => el.tagName === 'DIV');
  const sectionOf = (el) => { let n = el; while (n && n.parentElement && n.parentElement !== main) n = n.parentElement; return sections.indexOf(n); };

  const seen = new Set();
  const blockEls = [].concat(
    Array.prototype.slice.call(main.querySelectorAll('[data-block-name]')),
    Array.prototype.slice.call(main.querySelectorAll('div.block')),
  );
  blockEls.forEach((el) => {
    if (seen.has(el)) return; seen.add(el);
    const cls = Array.prototype.slice.call(el.classList);
    const name = el.dataset.blockName || cls.filter((c) => c !== 'block')[0];
    if (!name) return;
    const b = box(el);
    if (b.w < 8 || b.h < 8) return; // collapsed / not laid out
    base.blocks.push(Object.assign({ name: name, variant: cls.filter((c) => c !== 'block' && c !== name), section: sectionOf(el) }, b));
  });

  Array.prototype.forEach.call(main.querySelectorAll('div.default-content-wrapper'), (el) => {
    const b = box(el);
    if (b.w < 8 || b.h < 8) return;
    base.defaults.push(Object.assign({ section: sectionOf(el) }, b));
  });
  base.blocks.sort((a, b) => a.y - b.y);
  return base;
}
/* eslint-enable */

async function captureOne(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }));
    await page.waitForSelector('main', { timeout: 15000 }).catch(() => {});
    // EDS decorates blocks client-side; give the loaded status a chance, then auto-scroll to trigger
    // lazy sections + images (same reason scan stabilises), then return to top so boxes match the pears.
    await page.waitForSelector('main [data-block-status="loaded"]', { timeout: 8000 }).catch(() => {});
    await page.evaluate(async () => {
      await new Promise((res) => {
        let y = 0; const step = () => { window.scrollTo(0, y); y += 600; if (y < document.documentElement.scrollHeight) setTimeout(step, 60); else res(); };
        step();
      });
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const data = await page.evaluate(walkEds);
    return data;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function captureOracle(corpusDir, opts = {}) {
  const concurrency = opts.concurrency || 3;
  const pairsDir = resolvePairs(corpusDir);
  const u2d = urlToDir(pairsDir);
  const urls = [...u2d.keys()];
  if (!urls.length) { console.error(`no scanned pears under ${pairsDir} — run a scan first`); return { pages: 0 }; }

  const browser = await chromium.launch({ headless: true });
  let done = 0, blocks = 0, empty = 0;
  const queue = urls.map((u, i) => [u, i]);
  async function worker() {
    while (queue.length) {
      const [url] = queue.shift();
      try {
        const data = await captureOne(browser, url);
        const dir = u2d.get(url);
        fs.writeFileSync(path.join(dir, 'eds-oracle.json'), JSON.stringify(data));
        blocks += data.blocks.length;
        if (!data.blocks.length) empty++;
        console.log(`  ✓ ${data.blocks.length} blocks · ${data.defaults.length} default · ${url}`);
      } catch (e) {
        empty++;
        console.warn(`  ✕ oracle failed — ${url}: ${e.message}`);
      }
      done++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  await browser.close();
  console.log(`\noracle: ${done} pages · ${blocks} ground-truth blocks · ${empty} page(s) with no blocks (non-EDS or blocked?)`);
  return { pages: done, blocks, empty };
}

module.exports = { captureOracle, walkEds };

if (require.main === module) {
  const corpusDir = process.argv[2];
  const concurrency = parseInt(process.argv[3], 10) || 3;
  if (!corpusDir) { console.error('usage: node scoper/eds-oracle.js <corpusDir> [concurrency]'); process.exit(1); }
  captureOracle(corpusDir, { concurrency }).then((r) => { if (!r.pages) process.exit(1); }).catch((e) => { console.error(e); process.exit(1); });
}
