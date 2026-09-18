#!/usr/bin/env node
/*
 * scoper/align.js — grade detection against the EDS oracle + emit AUTO-CORRECTIONS (issue #65, Step 3).
 *
 *   node scoper/align.js <corpusDir> [storePath]
 *
 * This is the automated-feedback core. For every scanned page that also has an eds-oracle.json
 * (scoper/eds-oracle.js), it:
 *   1. runs the REAL detection (classifyPage, with the store) to get the tool's block bands, and
 *   2. matches them to the ground-truth EDS blocks by vertical overlap, producing
 *      (a) a SCORECARD  — recall / precision / boundary-IoU / per-block-name type consistency, i.e. an
 *          objective measure of how well the pipeline recovers the blocks a page is really made of; and
 *      (b) AUTO-CORRECTIONS — the same corrections.json a human would export, but derived from truth:
 *            • every ground-truth block  -> a REGION positive (its exact box, canonical name).
 *              This one signal covers confirmations, mistypes AND recall misses uniformly — the tool is
 *              taught the true block SHAPE wherever a real block sits, regardless of what its bands did.
 *            • a detected band over default content (no GT block) -> __notblock__  (over-admission guard)
 *            • a detected band spanning >=2 GT blocks            -> __split__      (over-fusion; the true
 *              pieces are already taught as region positives above)
 *
 * The auto-corrections feed scoper/analyze.js UNCHANGED — the whole learning engine is reused; only the
 * source of the verdicts is the DOM oracle instead of a human drawing on the screenshot.
 */

const fs = require('fs');
const path = require('path');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { classifyPage } = require('./band-class');

const COV = 0.5;      // fraction of the smaller box that must overlap to call it a match
const IOU_MIN = 0.3;  // a matched pair below this still counts for recall but flags a boundary problem

function resolvePairs(dir) {
  return fs.existsSync(path.join(dir, 'pairs')) ? path.join(dir, 'pairs') : dir;
}
function pngDims(file) {
  if (!fs.existsSync(file)) return { w: 0, h: 0 };
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
// Adopt EDS block names as canonical, normalised to the store's Title-Case convention so the common
// boilerplate names ("cards"/"hero"/"columns") merge with existing learned types instead of forking.
function canon(name) {
  return String(name || '').replace(/[-_]+/g, ' ').trim().split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ') || '(unnamed)';
}

const inter = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
function iou(a0, a1, b0, b1) {
  const i = inter(a0, a1, b0, b1); const u = (a1 - a0) + (b1 - b0) - i;
  return u > 0 ? i / u : 0;
}

function alignPage(pg, keyBucket, store) {
  const oraclePath = path.join(pg.dir, 'eds-oracle.json');
  if (!fs.existsSync(oraclePath)) return null;
  let oracle;
  try { oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8')); } catch { return null; }

  const bands = classifyPage(pg, keyBucket, { store });
  const detected = bands.filter((b) => b.cls === 'block').map((b) => ({ y0: b.y0, y1: b.y1, subtype: b.subtype }));
  const gt = (oracle.blocks || []).map((b) => ({ y0: b.y, y1: b.y + b.h, name: b.name, canon: canon(b.name), x: b.x, w: b.w, h: b.h, box: b }));
  const defaults = (oracle.defaults || []).map((d) => ({ y0: d.y, y1: d.y + d.h }));

  // recall: each GT block -> best-overlapping detected band
  const gtMatch = gt.map((g) => {
    let best = null;
    detected.forEach((d, di) => {
      const i = inter(g.y0, g.y1, d.y0, d.y1); const cov = i / Math.max(1, (g.y1 - g.y0));
      if (cov >= COV && (!best || cov > best.cov)) best = { di, cov, iou: iou(g.y0, g.y1, d.y0, d.y1), subtype: d.subtype };
    });
    return best;
  });
  // precision: each detected band -> does it cover a real GT block? and how many (over-fusion)?
  const detClass = detected.map((d) => {
    const covers = gt.filter((g) => inter(g.y0, g.y1, d.y0, d.y1) / Math.max(1, (g.y1 - g.y0)) >= COV);
    const onDefault = defaults.some((f) => inter(f.y0, f.y1, d.y0, d.y1) / Math.max(1, (d.y1 - d.y0)) >= COV);
    return { covers: covers.length, onDefault };
  });
  // over-cut: a GT block covered by >=2 detected bands (each taking a real slice of it)
  const overCut = gt.map((g) => detected.filter((d) => inter(g.y0, g.y1, d.y0, d.y1) / Math.max(1, Math.min(g.y1 - g.y0, d.y1 - d.y0)) >= COV).length >= 2);

  return { pg, oracle, detected, gt, defaults, gtMatch, detClass, overCut };
}

function alignCorpus(corpusDir, opts = {}) {
  const pairsDir = resolvePairs(corpusDir);
  const pears = loadPears(pairsDir);
  if (!pears.length) throw new Error(`no pears under ${pairsDir}`);
  const { keyBucket } = classifyDescriptors(pears);
  const storePath = opts.storePath || path.join(__dirname, 'store.json');
  const store = fs.existsSync(storePath) && Object.keys((JSON.parse(fs.readFileSync(storePath, 'utf8')).types) || {}).length
    ? require('./store').loadStore(storePath) : null;

  const corrections = {};
  const agg = { pages: 0, gt: 0, detected: 0, recalled: 0, precise: 0, iouSum: 0, iouN: 0, overCut: 0, overFuse: 0, falsePos: 0 };
  const confusion = {};   // canonGtName -> { toolSubtype: count }
  const perPage = [];

  for (const pg of pears) {
    const a = alignPage(pg, keyBucket, store);
    if (!a) continue;
    agg.pages++;
    const slug = path.basename(pg.dir);
    const { w: pngW, h: pngH } = pngDims(path.join(pg.dir, 'screenshots', 'source-full.png'));
    const dpr = pg.dpr || 1;
    const pageWcss = pngW / dpr || Math.max(...pg.nodes.map((n) => n.x + n.w));
    const pageHcss = pngH / dpr || Math.max(...pg.nodes.map((n) => n.y + n.h));
    const bands = classifyPage(pg, keyBucket, { store });
    const hostId = bands.length ? `${slug}_${Math.round(bands[0].y0)}` : null;

    // (a) SCORECARD tallies
    agg.gt += a.gt.length; agg.detected += a.detected.length;
    let pageRecalled = 0, pagePrecise = 0;
    a.gtMatch.forEach((m, gi) => {
      if (m) { agg.recalled++; pageRecalled++; agg.iouSum += m.iou; agg.iouN++; if (a.overCut[gi]) agg.overCut++;
        const gn = a.gt[gi].canon; (confusion[gn] = confusion[gn] || {}); confusion[gn][m.subtype] = (confusion[gn][m.subtype] || 0) + 1; }
    });
    a.detClass.forEach((c) => { if (c.covers >= 1) { agg.precise++; pagePrecise++; } else { agg.falsePos++; } if (c.covers >= 2) agg.overFuse++; });

    // (b) AUTO-CORRECTIONS
    // every ground-truth block -> a region positive (exact box, canonical name), hosted on any real band.
    if (hostId && a.gt.length) {
      const regions = a.gt.map((g) => ({
        x: Math.max(0, Math.min(1, g.x / pageWcss)), y: Math.max(0, Math.min(1, g.y0 / pageHcss)),
        w: Math.max(0, Math.min(1, g.w / pageWcss)), h: Math.max(0, Math.min(1, (g.y1 - g.y0) / pageHcss)),
        type: g.canon, reason: `EDS ground-truth block "${g.name}"`,
      }));
      corrections[hostId] = Object.assign(corrections[hostId] || {}, { url: pg.url, _auto: true, _via: 'eds-oracle', regions });
      if (!('type' in corrections[hostId])) corrections[hostId].type = '';
    }
    // detected bands that are over-admissions / over-fusions -> negative structural verdicts.
    // covers===0 means the band matches NO ground-truth block: by the oracle's own definition it is not a
    // block (default content, chrome, or over-cut prose), so it is a not-a-block negative — the exact
    // signal tuneAdmit needs to tighten the learned-admission threshold (matching the scorecard precision).
    a.detected.forEach((d, di) => {
      const id = `${slug}_${Math.round(d.y0)}`;
      const c = a.detClass[di];
      if (c.covers >= 2) { // spans multiple GT blocks -> over-fused
        if (id === hostId) corrections[id].type = '__split__'; else corrections[id] = { type: '__split__', was: d.subtype, url: pg.url, _auto: true, _via: 'eds-oracle' };
      } else if (c.covers === 0) { // matches no real block -> not a block
        const via = c.onDefault ? 'eds-oracle:default' : 'eds-oracle:unmatched';
        if (id === hostId) corrections[id].type = '__notblock__'; else corrections[id] = { type: '__notblock__', was: d.subtype, url: pg.url, _auto: true, _via: via };
      }
    });

    perPage.push({ slug, url: pg.url, gt: a.gt.length, detected: a.detected.length, recalled: pageRecalled, precise: pagePrecise });
  }

  // homogeneity: per GT block name, the fraction of its detected instances that got the majority tool label
  let homSum = 0, homN = 0;
  for (const [, dist] of Object.entries(confusion)) {
    const counts = Object.values(dist); const tot = counts.reduce((s, x) => s + x, 0); const maj = Math.max(...counts);
    if (tot) { homSum += maj / tot; homN++; }
  }
  const scorecard = {
    pages: agg.pages,
    gtBlocks: agg.gt,
    detectedBlocks: agg.detected,
    recall: agg.gt ? agg.recalled / agg.gt : 0,
    precision: agg.detected ? agg.precise / agg.detected : 0,
    meanIoU: agg.iouN ? agg.iouSum / agg.iouN : 0,
    typeConsistency: homN ? homSum / homN : 0,
    overFusedBands: agg.overFuse,
    overCutBlocks: agg.overCut,
    falsePositives: agg.falsePos,
    missedBlocks: agg.gt - agg.recalled,
    confusion,
    perPage,
  };
  return { scorecard, corrections };
}

function printScorecard(sc) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  console.log(`\n=== EDS scorecard — ${sc.pages} pages, ${sc.gtBlocks} ground-truth blocks ===`);
  console.log(`  recall            ${pct(sc.recall)}   (${sc.gtBlocks - sc.missedBlocks}/${sc.gtBlocks} real blocks detected · ${sc.missedBlocks} missed)`);
  console.log(`  precision         ${pct(sc.precision)}   (${sc.falsePositives} detected band(s) matched no real block)`);
  console.log(`  boundary IoU      ${sc.meanIoU.toFixed(2)}   (over-fused ${sc.overFusedBands} · over-cut ${sc.overCutBlocks})`);
  console.log(`  type consistency  ${pct(sc.typeConsistency)}   (how reliably each real block gets one tool label)`);
  const rows = Object.entries(sc.confusion).sort((a, b) => Object.values(b[1]).reduce((s, x) => s + x, 0) - Object.values(a[1]).reduce((s, x) => s + x, 0));
  if (rows.length) {
    console.log('\n  ground-truth block        tool labels (count)');
    console.log('  ------------------------  -----------------------------------');
    for (const [gn, dist] of rows) {
      const labels = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}×${c}`).join(', ');
      console.log(`  ${gn.padEnd(24).slice(0, 24)}  ${labels}`);
    }
  }
  console.log('');
}

module.exports = { alignCorpus, printScorecard, canon };

if (require.main === module) {
  const corpusDir = process.argv[2];
  const storePath = process.argv[3];
  if (!corpusDir) { console.error('usage: node scoper/align.js <corpusDir> [storePath]'); process.exit(1); }
  const { scorecard, corrections } = alignCorpus(corpusDir, { storePath });
  const outBase = path.dirname(resolvePairs(corpusDir));
  fs.writeFileSync(path.join(outBase, 'scorecard.json'), JSON.stringify(scorecard, null, 2));
  fs.writeFileSync(path.join(outBase, 'eds-corrections.json'), JSON.stringify(corrections, null, 2));
  printScorecard(scorecard);
  console.log(`scorecard  -> ${path.join(outBase, 'scorecard.json')}`);
  console.log(`auto-corr  -> ${path.join(outBase, 'eds-corrections.json')}  (${Object.keys(corrections).length} host entries)`);
  console.log(`\nlearn from it:  node scoper/analyze.js ${path.join(outBase, 'eds-corrections.json')} ${resolvePairs(corpusDir)}\n`);
}
