/**
 * Strict match acceptance: prompt tuning + programmatic gates before target stitch.
 */

const { pixelsToNormBbox } = require('./image-utils');

const MATCH_PROMPT_BASE = `You compare a **small crop** from a source page (first image) with the **full target page screenshot** (second image).

The first image is **one** isolated source block. Find whether that **exact section** exists on the target — same purpose, headlines, and primary messages (minor wording/layout differences OK).

**Strict matching rules:**
- Use the source block's **relative position** (% from top of page) to search the same band on the target first.
- \`found: true\` only when you are **confident** this is the same section, not a generic lookalike (another card row, promo band, or footer elsewhere).
- **Do not** match a block just because layout is similar — headlines and key copy must correspond.
- If the target has **different** content in that area, or only vague similarity, return \`found: false\` with confidence ≤ 0.4.
- When uncertain, choose \`found: false\` — wrong matches delete target content permanently.

Respond with ONLY valid JSON:
{
  "found": true,
  "confidence": 0.92,
  "bbox": { "x": 0, "y": 0, "width": 0, "height": 0 },
  "rationale": "one short sentence"
}

Rules when found:
- Normalized bbox 0–1 on the **full** target image; surgically tight around that block only.

When not found:
{ "found": false, "confidence": 0.2, "rationale": "why no match" }`;

function envFloat(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

function loadMatchThresholds() {
  return {
    minConfidence: envFloat('PPD_MATCH_MIN_CONFIDENCE', 0.85),
    minConfidenceIfReordered: envFloat('PPD_MATCH_MIN_CONFIDENCE_REORDERED', 0.9),
    /** Max |sourceMidRatio - targetMidRatio| on each full page (not absolute px). */
    maxRelativeVerticalDelta: envFloat('PPD_MATCH_MAX_RELATIVE_VERTICAL_DELTA', 0.14),
    maxHeightRatioSkew: envFloat('PPD_MATCH_MAX_HEIGHT_RATIO_SKEW', 0.75),
    maxIouWithPrior: envFloat('PPD_MATCH_MAX_IOU_WITH_PRIOR', 0.2),
  };
}

function rectIoU(a, b) {
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
 * Compare block center as fraction of each page height (handles different page lengths).
 */
function relativeVerticalPlacement(sourceBboxOnPage, targetBboxOnPage, sourcePageHeight, targetPageHeight) {
  const srcH = sourcePageHeight || 1;
  const tgtH = targetPageHeight || 1;
  const sourceMidRatio = (sourceBboxOnPage.y + sourceBboxOnPage.height / 2) / srcH;
  const targetMidRatio = (targetBboxOnPage.y + targetBboxOnPage.height / 2) / tgtH;
  const delta = targetMidRatio - sourceMidRatio;
  const tolerance = loadMatchThresholds().maxRelativeVerticalDelta;
  if (Math.abs(delta) <= tolerance) return { placement: 'aligned', delta, sourceMidRatio, targetMidRatio };
  if (delta > tolerance) return { placement: 'lower_on_page', delta, sourceMidRatio, targetMidRatio };
  return { placement: 'higher_on_page', delta, sourceMidRatio, targetMidRatio };
}

/**
 * @param {object} params
 */
function evaluateMatchAcceptance(params) {
  const {
    match,
    sourceBboxOnPage,
    targetRectFull,
    sourcePageHeight,
    targetPageHeight,
    priorMatchedRegions = [],
    thresholds = loadMatchThresholds(),
  } = params;

  const reasons = [];
  const aiFound = match?.found === true && Boolean(match?.bbox);

  if (!aiFound || !targetRectFull) {
    return {
      accepted: false,
      reasons: aiFound ? ['invalid_bbox'] : ['ai_not_found'],
      placement: null,
      relativeVerticalDelta: null,
      aiFound,
      confidence: match?.confidence ?? null,
    };
  }

  const confidence = typeof match.confidence === 'number' ? match.confidence : 0;
  const rel = relativeVerticalPlacement(
    sourceBboxOnPage,
    targetRectFull,
    sourcePageHeight,
    targetPageHeight
  );
  const placement = rel.placement;
  const relativeVerticalDelta = Math.abs(rel.delta);

  if (confidence < thresholds.minConfidence) {
    reasons.push('confidence_below_min');
  }

  if (placement !== 'aligned') {
    if (confidence < thresholds.minConfidenceIfReordered) {
      reasons.push('reordered_low_confidence');
    }
    if (relativeVerticalDelta > thresholds.maxRelativeVerticalDelta) {
      reasons.push('relative_vertical_offset_exceeded');
    }
  }

  const srcH = sourceBboxOnPage.height || 1;
  const tgtH = targetRectFull.height || 1;
  const skew = Math.abs(Math.log(tgtH / srcH));
  const heightOk =
    skew <= thresholds.maxHeightRatioSkew ||
    (placement === 'aligned' && confidence >= thresholds.minConfidence);
  if (!heightOk) {
    reasons.push('height_ratio_mismatch');
  }

  for (const prior of priorMatchedRegions) {
    if (!prior?.bbox) continue;
    if (rectIoU(targetRectFull, prior.bbox) > thresholds.maxIouWithPrior) {
      reasons.push('overlaps_prior_match');
      break;
    }
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    placement,
    relativeVerticalDelta,
    sourceMidRatio: rel.sourceMidRatio,
    targetMidRatio: rel.targetMidRatio,
    aiFound,
    confidence,
  };
}

/**
 * Cached-mode base: same rules as MATCH_PROMPT_BASE but images are TARGET-first
 * so the stable target image can be the cached prefix (the varying crop follows).
 * Kept separate from MATCH_PROMPT_BASE so the default (uncached) prompt is
 * byte-identical; keep the rules in sync if MATCH_PROMPT_BASE changes.
 */
const MATCH_PROMPT_BASE_CACHED = `You compare a **small crop** from a source page with the **full target page screenshot**.

Image order: the **first image is the full target page**; the **second image is the source crop** — one isolated source block. Find whether that **exact section** exists on the target — same purpose, headlines, and primary messages (minor wording/layout differences OK).

**Strict matching rules:**
- Use the source block's **relative position** (% from top of page) to search the same band on the target first.
- \`found: true\` only when you are **confident** this is the same section, not a generic lookalike (another card row, promo band, or footer elsewhere).
- **Do not** match a block just because layout is similar — headlines and key copy must correspond.
- If the target has **different** content in that area, or only vague similarity, return \`found: false\` with confidence ≤ 0.4.
- When uncertain, choose \`found: false\` — wrong matches delete target content permanently.

Respond with ONLY valid JSON:
{
  "found": true,
  "confidence": 0.92,
  "bbox": { "x": 0, "y": 0, "width": 0, "height": 0 },
  "rationale": "one short sentence"
}

Rules when found:
- Normalized bbox 0–1 on the **full** target image; surgically tight around that block only.

When not found:
{ "found": false, "confidence": 0.2, "rationale": "why no match" }`;

/** The per-iteration (varying) context appended after the static match base. */
function buildMatchContext(
  alreadyMatchedOnTarget,
  sourceBboxOnPage,
  pageWidth,
  pageHeight,
  targetPageHeight
) {
  const sourceNorm = pixelsToNormBbox(sourceBboxOnPage, pageWidth, pageHeight);
  const midRatio =
    (sourceBboxOnPage.y + sourceBboxOnPage.height / 2) / (pageHeight || 1);
  let ctx = `**Source block position** on the original source page:
- normalized bbox: ${JSON.stringify(sourceNorm)}
- vertical center ≈ **${(midRatio * 100).toFixed(1)}%** from the top of the source page — search the same **relative band** on the target (target page height may differ).`;

  if (alreadyMatchedOnTarget.length) {
    const summary = alreadyMatchedOnTarget.map((m) => ({
      iter: m.iter,
      label: m.label,
      bbox: m.bboxNorm,
    }));
    ctx += `

These target regions are **already matched** — do not match this crop to them again:
${JSON.stringify(summary, null, 2)}`;
  }

  if (targetPageHeight && targetPageHeight !== pageHeight) {
    ctx += `

Note: source page height ≈ ${pageHeight}px, target page height ≈ ${targetPageHeight}px — use **relative** vertical position, not absolute pixel y.`;
  }

  return ctx;
}

function buildMatchPrompt(
  alreadyMatchedOnTarget,
  sourceBboxOnPage,
  pageWidth,
  pageHeight,
  targetPageHeight
) {
  return `${MATCH_PROMPT_BASE}

${buildMatchContext(alreadyMatchedOnTarget, sourceBboxOnPage, pageWidth, pageHeight, targetPageHeight)}`;
}

module.exports = {
  MATCH_PROMPT_BASE,
  MATCH_PROMPT_BASE_CACHED,
  loadMatchThresholds,
  rectIoU,
  relativeVerticalPlacement,
  evaluateMatchAcceptance,
  buildMatchPrompt,
  buildMatchContext,
};
