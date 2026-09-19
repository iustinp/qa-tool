/*
 * scoper/band-class.js — classify each band from band-cut as BLOCK / DEFAULT / CHROME (issue #65).
 *
 * Scoping cares only about BLOCKS (distinct block types + counts = migration effort); default
 * content (headings, paragraphs, lists, lone images) imports at ~0 effort and is discarded; chrome
 * (header/footer/nav) is a known template constant. So the job is: keep block bands, drop the rest.
 *
 * Signals reused (already validated elsewhere):
 *   - CHROME: the cross-page vocabulary discriminator (chrome.js keyBucket) — chrome/nav/legal
 *     recur with IDENTICAL text across pages.
 *   - BLOCK: within-band REPETITION (lattice.js detectPageLattices) — the strongest, content-blind
 *     block signal (cards / columns / gallery / list / stats). Plus a conservative composed-singleton
 *     rule for image+heading heroes/media (low-confidence; flagged).
 * Purely additive; no edits to lib/ or existing scoper files.
 */

const { descriptor } = require('./signature');
const { bandCut } = require('./band-cut');
const { tokenStats, featureVector } = require('./features');
const { typeOf, TAU_ADMIT } = require('./store');
const { mergeSegments } = require('./merge');

// Deterministic EDS-ish block subtype from content-blind signals (Step-1 typing, no AI):
// image-repetition + axis (cards/gallery/grid), size tiers (stats), width + display heading (hero),
// column count (columns). Accordion/Tabs/Carousel need affordance/overflow signals — deferred.
function subtypeOf(x) {
  const { ts, texts, imgs, imgRow, wideImg, display, toggles = 0, tabsLike = false } = x;
  const repeatedText = ts.filter((s) => !s.isImg && s.cols >= 2 && s.count >= 2);
  const cols = repeatedText.reduce((m, s) => Math.max(m, s.cols), 0);

  // Hero / banner — a wide (near-full-bleed) image + a display heading, and NOT a card grid.
  // (Checked before toggles so stray header-nav dropdown toggles bleeding into the top band don't steal it.)
  if (wideImg && display && !(imgRow && imgRow.count >= 3)) return { subtype: 'Hero', why: 'wide image + display heading' };

  // Toggle affordance (aria-expanded/controls) — accordion/tabs. Require >=3 so a couple of nav
  // dropdown toggles don't read as an accordion; >=3 in a horizontal row = Tabs, else Accordion.
  if (toggles >= 3 && tabsLike) return { subtype: 'Tabs', why: `${toggles} toggles in a row` };
  if (toggles >= 3) return { subtype: 'Accordion', why: `toggle ×${toggles}` };

  // Image-repeating peers — Cards (image + repeated text) vs Gallery (image-dominant, ~no text).
  if (imgRow) {
    const grid = imgRow.rows >= 2;
    if (repeatedText.length >= 1) return { subtype: grid ? 'Cards (grid)' : 'Cards', why: `IMG ×${imgRow.count}/${imgRow.cols}col + text` };
    return { subtype: grid ? 'Gallery (grid)' : 'Gallery', why: `IMG ×${imgRow.count}/${imgRow.cols}col, ~no text` };
  }

  // Text-only structures.
  const bigTier = repeatedText.find((s) => s.size >= 24 && s.cols <= 5);      // stat numbers
  const smallTier = repeatedText.find((s) => s.size < 24 && s.cols <= 5);     // stat labels
  if (bigTier && smallTier && cols >= 2 && cols <= 5 && texts.length <= cols * 3 + 3)
    return { subtype: 'Stats / Counter', why: `${cols}× big+small tier` };

  const grid2d = repeatedText.find((s) => s.rows >= 2 && s.cols >= 2);
  if (grid2d) return { subtype: 'Grid', why: `2D text ${grid2d.cols}×${grid2d.rows}` };

  if (cols >= 2 && cols <= 3) return { subtype: 'Columns', why: `${cols} text columns` };
  if (imgs.length >= 1) return { subtype: 'Media (image+text)', why: 'image + text' };
  return { subtype: 'Columns', why: 'text columns' };
}

// bandNodes: this band's pear nodes. keyBucket: from chrome.classifyDescriptors(allPears).
// pageNodes: the full page's nodes (needed to compute each node's cross-page descriptor).
function classifyBand(bandNodes, keyBucket, pageNodes, store, clickables = []) {
  // 1) chrome — dominated by identical-across-pages boilerplate (header/footer/nav/share). Checked
  //    FIRST because nav/share also repeat across columns and would otherwise look like a block.
  //    Only the CHROME bucket counts (once-per-page site frame); LABEL is deliberately EXCLUDED —
  //    LABEL is the "bounded pool" regime ("Read more", reused related-article titles) that lives
  //    INSIDE content blocks, so counting it here suppressed the related-articles cards as chrome.
  let chromeN = 0;
  for (const n of bandNodes) { if (keyBucket.get(descriptor(n, pageNodes)) === 'CHROME') chromeN++; }
  const chromeFrac = bandNodes.length ? chromeN / bandNodes.length : 0;
  if (chromeFrac >= 0.5) return { cls: 'chrome', subtype: 'header/footer/nav', why: `chrome ${Math.round(chromeFrac * 100)}%` };

  // 2) is this a BLOCK? horizontal repetition of a token across columns, OR a hero (a near-full-bleed
  //    image + a display heading, which need not repeat). IMAGES must clear a size floor so social/
  //    icon rows (~48px) don't read as a mini gallery; display-size text (>=48px, a wrapped title) is
  //    kept out of the text-column triggers.
  const IMG_FLOOR = 64;  // content-card images are >=140px short-side; social/share icons ~48px
  const DISPLAY = 48;    // >=48px text = a display heading
  const pageW = Math.max(100, ...pageNodes.map((n) => n.x + n.w));
  const texts = bandNodes.filter((n) => n.kind === 'text');
  const imgs = bandNodes.filter((n) => n.kind !== 'text');
  const ts = tokenStats(bandNodes);
  const bigEnough = (s) => !s.isImg || Math.min(s.medW, s.medH) >= IMG_FLOOR;
  const bodyText = (s) => !s.isImg && s.size < DISPLAY;
  const imgRow = ts.find((s) => s.isImg && s.cols >= 2 && s.count >= 2 && bigEnough(s));
  const textGrid = ts.find((s) => bodyText(s) && s.cols >= 3 && s.count >= 3);
  const multiCol = ts.filter((s) => s.cols >= 2 && s.count >= 2 && bigEnough(s) && (s.isImg || bodyText(s)));
  const wideImg = imgs.find((n) => n.w >= 0.6 * pageW && Math.min(n.w, n.h) >= IMG_FLOOR);
  const display = ts.find((s) => !s.isImg && s.size >= DISPLAY);

  // AFFORDANCE (cold-start signal): a real toggle (accordion/tabs) or a CTA button marks a DESIGNED
  // block, no repetition needed. Bare links are excluded (nav/prose are links); a CTA is type
  // action/button, or a link with a button-ish standalone box. A CTA counts only alongside content.
  const toggles = clickables.filter((c) => c.type === 'toggle');
  const ctas = clickables.filter((c) => c.type === 'action' || c.type === 'button'
    || (c.type === 'link' && c.h >= 28 && c.w >= 56 && c.w <= 0.5 * pageW));
  const tabsLike = toggles.length >= 3 && (Math.max(...toggles.map((t) => t.y)) - Math.min(...toggles.map((t) => t.y)) < 40);
  const hasContent = imgs.length >= 1 || !!display || texts.length >= 3;
  const affordance = toggles.length >= 3 || (ctas.length >= 1 && hasContent);

  const heuristicBlock = imgRow || textGrid || multiCol.length >= 2 || (wideImg && display) || affordance;
  const hasStore = store && store.types && Object.keys(store.types).length;
  const bandVec = hasStore ? featureVector(bandNodes, pageW) : null;
  const r = bandVec ? typeOf(store, bandVec) : { type: null };

  if (heuristicBlock) {
    // an already-block band: the store re-types it at its learned radius (or the heuristic names it)
    if (r.type) return { cls: 'block', subtype: r.type, why: `learned (d=${r.dist.toFixed(2)})` };
    const { subtype, why } = subtypeOf({ ts, texts, imgs, imgRow, wideImg, display, toggles: toggles.length, tabsLike });
    return { cls: 'block', subtype, why };
  }
  // LEARNED ADMISSION (Step 2): a band the heuristics would DROP is still admitted if it CONFIDENTLY
  // matches a learned prototype (taught by drawing a region over a previously-ignored structure).
  // Admission uses a TIGHT threshold (much tighter than the learned radius, store.tuneAdmit fits it to
  // maximise F1 over the corrections; else the cold TAU_ADMIT default) and a ✕-Not-a-block guard
  // suppresses via typeOf. It ALSO requires STRUCTURAL evidence: a featureless prose-like band is never
  // admitted even when a (featureless) text-block prototype sits right next to it — that proximity
  // carries no signal, and content-blind vectors can't separate a text-only block from default prose.
  const admit = store && typeof store.tauAdmit === 'number' ? store.tauAdmit : TAU_ADMIT;
  const structured = bandVec && (bandVec.hasImage || bandVec.imgCols || bandVec.textCols || bandVec.textRows || bandVec.hasDisplay);
  if (structured && r.type && r.dist <= admit) return { cls: 'block', subtype: r.type, why: `learned-admit (d=${r.dist.toFixed(2)})` };
  const why = texts.length >= 4 ? 'prose' : (texts.length <= 2 && imgs.length <= 1 ? 'heading/lone' : 'default');
  return { cls: 'default', subtype: 'default content', why };
}

function classifyPage(page, keyBucket, opts = {}) {
  const pageW = opts.pageW || Math.max(100, ...page.nodes.map((n) => n.x + n.w));
  const pageH = opts.pageH || Math.max(100, ...page.nodes.map((n) => n.y + n.h));
  let { bands } = bandCut(page.nodes, pageW, pageH);
  if (opts.store) bands = mergeSegments(bands, page.nodes, pageW, opts.store);  // store-driven re-join of split blocks
  return bands.map((b) => {
    const bn = page.nodes.filter((n) => (n.y + n.h) > b.y0 && n.y < b.y1);
    if (b.forcedType) return { ...b, cls: 'block', subtype: b.forcedType, why: `merged ×${b.mergedFrom} (learned)`, bandNodeCount: bn.length };
    const bandClk = (page.clickables || []).filter((c) => (c.y + c.h) > b.y0 && c.y < b.y1);
    return { ...b, ...classifyBand(bn, keyBucket, page.nodes, opts.store, bandClk), bandNodeCount: bn.length };
  });
}

module.exports = { classifyBand, classifyPage };
