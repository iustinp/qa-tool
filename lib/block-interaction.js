/**
 * Vision-guided interaction discovery and DOM resolution (class-name agnostic).
 * Used at capture (full-page scan) and during the segment loop (per-block crops).
 */

const { visionJson } = require('./claude');
const { resizeForVision } = require('./image-utils');
const { extractVisibleText } = require('./visible-text');

const DEFAULT_MAX_ACTIVATIONS = 30;
const DEFAULT_MAX_NEXT_CLICKS = 12;
const DEFAULT_SETTLE_MS = 300;

const FULL_PAGE_INTERACTION_PROMPT = `You are analyzing a **full-page website screenshot** (entire scrollable page).

Find UI regions where **clicking controls reveals additional text** that is not visible in the initial view (carousels/sliders, tab strips, accordions, steppers, dot indicators, "show more" within a band, etc.).

Ignore: normal links that navigate away, cookie banners, video play buttons, search fields, pagination to other pages.

For each region, list **clickable controls** the tool should activate to reveal hidden copy. Use **normalized coordinates 0–1** relative to this image (x,y = top-left of each box).

Respond with ONLY valid JSON:
{
  "regions": [
    {
      "kind": "carousel",
      "label": "hero slider",
      "blockBbox": { "x": 0, "y": 0.05, "width": 1, "height": 0.35 },
      "controls": [
        { "role": "next", "bbox": { "x": 0.92, "y": 0.18, "width": 0.04, "height": 0.06 } },
        { "role": "slide_indicator", "bbox": { "x": 0.45, "y": 0.32, "width": 0.02, "height": 0.02 } }
      ],
      "suggestedPasses": 4
    }
  ]
}

Rules:
- \`blockBbox\` tightly wraps the interactive component only (not the whole page).
- \`controls[].bbox\` tightly wraps one button/dot/tab control.
- \`role\`: one of next, prev, tab, slide_indicator, accordion, show_more, other.
- If nothing needs expansion, return { "regions": [] }.`;

const CROP_INTERACTION_PROMPT = `You are analyzing a **crop of one page section** (one block).

Determine if this block **hides copy behind interaction** (carousel, tabs, accordion, etc.).

If not expandable, respond:
{ "expandable": false }

If expandable, respond with ONLY valid JSON:
{
  "expandable": true,
  "kind": "carousel",
  "controls": [
    { "role": "next", "bbox": { "x": 0.9, "y": 0.4, "width": 0.05, "height": 0.08 } }
  ],
  "suggestedPasses": 4
}

Coordinates are **normalized 0–1 relative to this crop image** (not the full page).
List every control needed to reveal hidden text (next/prev, dots, tab labels, accordion headers).`;

const SEGMENT_INTERACTION_ADDENDUM = `

Additionally assess whether this block hides text behind interaction (carousel, tabs, accordion, etc.).
If yes, include an "interaction" object (coordinates relative to **this same image**):
{
  "done": false,
  "label": "...",
  "bbox": { ... },
  "interaction": {
    "expandable": true,
    "kind": "carousel",
    "controls": [ { "role": "next", "bbox": { "x": 0.9, "y": 0.4, "width": 0.05, "height": 0.08 } } ],
    "suggestedPasses": 4
  }
}
If not expandable, omit "interaction" or set "interaction": { "expandable": false }.`;

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function getTextExpansionMode() {
  const mode = (process.env.PPD_TEXT_EXPANSION_MODE || 'selectors').trim().toLowerCase();
  if (['selectors', 'vision', 'both', 'segment'].includes(mode)) return mode;
  return 'selectors';
}

function isBlockInteractionManifestEnabled() {
  const v = process.env.PPD_BLOCK_INTERACTION;
  if (v === '1' || v === 'true') return true;
  return getTextExpansionMode() === 'segment';
}

function isSegmentInteractionReplayEnabled() {
  const v = process.env.PPD_SEGMENT_INTERACTION_REPLAY;
  return v === '1' || v === 'true';
}

function centerOfNormBbox(bbox) {
  return {
    x: bbox.x + bbox.width / 2,
    y: bbox.y + bbox.height / 2,
  };
}

/**
 * Map a control bbox in crop-normalized space to full-page-normalized space.
 */
function controlToPageNorm(controlBbox, blockPageNorm) {
  return {
    x: blockPageNorm.x + controlBbox.x * blockPageNorm.width,
    y: blockPageNorm.y + controlBbox.y * blockPageNorm.height,
    width: controlBbox.width * blockPageNorm.width,
    height: controlBbox.height * blockPageNorm.height,
  };
}

/**
 * Pixel rect on document from normalized full-page coords.
 */
function normToDocPixels(norm, docWidth, docHeight) {
  return {
    x: Math.round(norm.x * docWidth),
    y: Math.round(norm.y * docHeight),
    width: Math.round(norm.width * docWidth),
    height: Math.round(norm.height * docHeight),
  };
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * @param {import('playwright').Page} page
 * @param {{ x: number, y: number, width: number, height: number }} regionPx document-space pixels
 */
async function collectClickableCandidates(page, regionPx) {
  return page.evaluate((region) => {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const out = [];
    const selectors =
      'button, a[href], [role="button"], [role="tab"], summary, input[type="button"], input[type="submit"]';
    document.querySelectorAll(selectors).forEach((el, index) => {
      if (!(el instanceof HTMLElement)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const doc = {
        x: rect.x + scrollX,
        y: rect.y + scrollY,
        width: rect.width,
        height: rect.height,
      };
      const cx = doc.x + doc.width / 2;
      const cy = doc.y + doc.height / 2;
      if (
        cx < region.x ||
        cy < region.y ||
        cx > region.x + region.width ||
        cy > region.y + region.height
      ) {
        return;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (parseFloat(style.opacity) < 0.05) return;
      const label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        (el.textContent || '').replace(/\s+/g, ' ').trim()
      ).slice(0, 120);
      out.push({
        index,
        tagName: el.tagName,
        role: el.getAttribute('role'),
        label,
        bbox: doc,
      });
    });
    return out;
  }, regionPx);
}

/**
 * @param {import('playwright').Page} page
 * @param {{ x: number, y: number }} docPoint
 */
async function clickDocumentPoint(page, docPoint) {
  const clicked = await page.evaluate(({ x, y }) => {
    const prevY = window.scrollY;
    const targetY = Math.max(0, y - window.innerHeight / 2);
    window.scrollTo(0, targetY);
    const vx = x - window.scrollX;
    const vy = y - window.scrollY;
    const el = document.elementFromPoint(vx, vy);
    if (!el || !(el instanceof HTMLElement)) return { ok: false, reason: 'no_element' };
    let node = el;
    for (let d = 0; d < 6 && node; d++) {
      if (
        node instanceof HTMLButtonElement ||
        node instanceof HTMLAnchorElement ||
        node.getAttribute('role') === 'button' ||
        node.getAttribute('role') === 'tab' ||
        node.tagName === 'SUMMARY'
      ) {
        node.click();
        return { ok: true, tag: node.tagName, scrolledFrom: prevY, scrolledTo: targetY };
      }
      node = node.parentElement;
    }
    el.click();
    return { ok: true, tag: el.tagName, fallback: true };
  }, docPoint);
  return clicked;
}

/**
 * Resolve vision control bbox to best DOM candidate or center click.
 */
async function resolveAndClickControl(page, controlNorm, blockPageNorm, docSize, clickLog) {
  const controlPageNorm = controlToPageNorm(controlNorm, blockPageNorm);
  const center = centerOfNormBbox(controlPageNorm);
  const targetPx = {
    x: Math.round(center.x * docSize.width),
    y: Math.round(center.y * docSize.height),
  };
  const pad = 48;
  const regionPx = {
    x: Math.max(0, targetPx.x - pad),
    y: Math.max(0, targetPx.y - pad),
    width: pad * 2,
    height: pad * 2,
  };
  const controlPx = normToDocPixels(controlPageNorm, docSize.width, docSize.height);
  const candidates = await collectClickableCandidates(page, regionPx);
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = iou(c.bbox, controlPx);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  const entry = {
    role: controlNorm.role || 'other',
    visionCenter: targetPx,
    matchedDom: best ? { label: best.label, tagName: best.tagName, iou: bestScore } : null,
    ok: false,
  };
  if (best && bestScore >= 0.05) {
    const cx = best.bbox.x + best.bbox.width / 2;
    const cy = best.bbox.y + best.bbox.height / 2;
    entry.ok = (await clickDocumentPoint(page, { x: cx, y: cy })).ok;
    entry.via = 'dom_match';
  } else {
    entry.ok = (await clickDocumentPoint(page, targetPx)).ok;
    entry.via = 'vision_center';
  }
  if (clickLog) clickLog.push(entry);
  return entry.ok;
}

/**
 * @param {import('playwright').Page} page
 * @param {object[]} regions manifest regions (page-normalized bboxes)
 * @param {object} opts
 */
async function applyInteractionRegions(page, regions, opts = {}) {
  const settleMs = opts.settleMs ?? envInt('PPD_TEXT_EXPANSION_SETTLE_MS', DEFAULT_SETTLE_MS);
  const maxActivations = opts.maxActivations ?? envInt('PPD_TEXT_EXPANSION_MAX_ACTIVATIONS', DEFAULT_MAX_ACTIVATIONS);
  const maxNextClicks = opts.maxNextClicks ?? envInt('PPD_TEXT_EXPANSION_MAX_NEXT_CLICKS', DEFAULT_MAX_NEXT_CLICKS);
  const extractOpts = opts.extractOpts || {};
  const clickLog = opts.clickLog ? [] : null;

  const docSize = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, 1),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, 1),
  }));

  const baseline = await extractVisibleText(page, extractOpts);
  const union = new Set(baseline.visibleText);
  let activations = 0;

  for (const region of regions) {
    if (activations >= maxActivations) break;
    const blockNorm = region.blockBbox;
    if (!blockNorm) continue;
    const controls = Array.isArray(region.controls) ? region.controls : [];
    const passes = Math.min(
      region.suggestedPasses || maxNextClicks,
      maxNextClicks,
      maxActivations - activations
    );

    const nextControls = controls.filter((c) => c.role === 'next' || c.role === 'other');
    const otherControls = controls.filter((c) => c.role !== 'next' && c.role !== 'other');

    for (const c of otherControls) {
      if (activations >= maxActivations) break;
      if (!c.bbox) continue;
      await resolveAndClickControl(page, c, blockNorm, docSize, clickLog);
      await page.waitForTimeout(settleMs);
      const { visibleText } = await extractVisibleText(page, extractOpts);
      for (const line of visibleText) union.add(line);
      activations += 1;
    }

    const nextBbox = nextControls[0]?.bbox;
    if (!nextBbox) continue;

    for (let p = 0; p < passes && activations < maxActivations; p++) {
      const before = union.size;
      await resolveAndClickControl(page, nextControls[0], blockNorm, docSize, clickLog);
      await page.waitForTimeout(settleMs);
      const { visibleText } = await extractVisibleText(page, extractOpts);
      for (const line of visibleText) union.add(line);
      activations += 1;
      if (union.size === before && p >= 1) break;
    }
  }

  const expandedVisibleText = Array.from(union);
  return {
    visibleText: baseline.visibleText,
    expandedVisibleText,
    visibleTextCharCount: baseline.visibleTextCharCount,
    expandedVisibleTextCharCount: expandedVisibleText.reduce((n, l) => n + l.length, 0),
    expansion: {
      enabled: true,
      mode: 'vision',
      activations,
      baselineLineCount: baseline.visibleText.length,
      expandedLineCount: expandedVisibleText.length,
      linesAddedByExpansion: expandedVisibleText.length - baseline.visibleText.length,
      regionCount: regions.length,
      clickLog,
    },
  };
}

async function discoverFullPageInteractions(screenshotBuffer) {
  const vision = await resizeForVision(screenshotBuffer);
  const result = await visionJson(
    [
      { type: 'image_buffer', buffer: vision.buffer },
      {
        type: 'text',
        text: `${FULL_PAGE_INTERACTION_PROMPT}\n\n(Image: ${vision.visionWidth}x${vision.visionHeight})`,
      },
    ],
    4096
  );
  const parsed = result.parsed;
  if (!parsed || !Array.isArray(parsed.regions)) {
    return { regions: [], rawPreview: result.rawText?.slice(0, 500) || null };
  }
  return { regions: parsed.regions, rawPreview: null };
}

async function analyzeCropInteraction(cropBuffer, label) {
  const vision = await resizeForVision(cropBuffer, 1200);
  const result = await visionJson(
    [
      { type: 'image_buffer', buffer: vision.buffer },
      {
        type: 'text',
        text: `${CROP_INTERACTION_PROMPT}\n\nBlock label: ${label || 'unknown'}\n(Image: ${vision.visionWidth}x${vision.visionHeight})`,
      },
    ],
    2048
  );
  return result.parsed || { expandable: false };
}

/**
 * Build a manifest entry from segment iteration (remainder → full page coords).
 */
function manifestEntryFromSegment({
  iter,
  label,
  segmentBboxPx,
  remainderTopPx,
  fullPageWidth,
  fullPageHeight,
  interaction,
}) {
  if (!interaction || interaction.expandable !== true) return null;
  const blockPageNorm = {
    x: segmentBboxPx.x / fullPageWidth,
    y: (segmentBboxPx.y + remainderTopPx) / fullPageHeight,
    width: segmentBboxPx.width / fullPageWidth,
    height: segmentBboxPx.height / fullPageHeight,
  };
  const controls = (interaction.controls || [])
    .filter((c) => c && c.bbox)
    .map((c) => ({
      role: c.role || 'other',
      bbox: controlToPageNorm(c.bbox, blockPageNorm),
    }));

  return {
    iter,
    label: label || null,
    kind: interaction.kind || 'unknown',
    blockBbox: blockPageNorm,
    controls,
    suggestedPasses: interaction.suggestedPasses || 4,
    segmentBboxPx,
    remainderTopPx,
  };
}

function mergeManifestEntries(entries) {
  return entries.filter(Boolean);
}

module.exports = {
  FULL_PAGE_INTERACTION_PROMPT,
  CROP_INTERACTION_PROMPT,
  SEGMENT_INTERACTION_ADDENDUM,
  getTextExpansionMode,
  isBlockInteractionManifestEnabled,
  isSegmentInteractionReplayEnabled,
  discoverFullPageInteractions,
  analyzeCropInteraction,
  applyInteractionRegions,
  manifestEntryFromSegment,
  mergeManifestEntries,
  controlToPageNorm,
  normToDocPixels,
};
