/**
 * Guardrails against card-row splits (image strip vs link strip) on SOURCE segmentation.
 * Must NOT apply to heroes, banners, or labels that merely contain "promotion".
 */

const NON_CARD_ROW_LABEL_RE =
  /hero|banner|masthead|jumbotron|footer|disclosure|legal|disclaimer|connect with us|account login|navigation|nav bar|site header|sticky nav/i;

const CARD_ROW_LABEL_RE =
  /\bcards?\b|happening now|card row|promotional cards|promo cards|three card|3 card|category icon|icon row|tile row|teaser row|borrowing.*\bcards?\b|financing.*\bcards?\b/i;

const CARD_TEXT_FRAGMENT_RE =
  /link|headline|cta|caption|title row|text row|promo cards with headlines/i;

const CARD_ROW_EXPAND_ADDENDUM = `

Your previous bbox likely **split a card row** — it may include card images but **omit** the headline/link lines directly below each card.

Return ONE bbox that includes **the full card row**: section title (if any) + all card images/thumbnails + **every** caption, headline, and link line under those cards. Extend **downward** until the next unrelated section begins.`;

function cardRowExpandRetryAddendum(heightPx, remainderHeightPx) {
  return `

Your bbox is only about **${heightPx}px** tall in a ~${remainderHeightPx}px remainder. Full card rows here are typically **${minCardRowHeightPx()}px or more** (images + link lines combined).

Extend the bbox **downward** to include ALL link/title lines under the card images. Do not stop at the image bottom.`;
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function minCardRowHeightPx() {
  return envInt('PPD_SEGMENT_MIN_CARD_ROW_HEIGHT_PX', 620);
}

function maxCardRowExtendPx() {
  return envInt('PPD_SEGMENT_CARD_ROW_MAX_EXTEND_PX', 200);
}

function maxCardTextFragmentHeightPx() {
  return envInt('PPD_SEGMENT_MAX_CARD_FRAGMENT_HEIGHT_PX', 280);
}

function maxCardContinuationStripHeightPx() {
  return envInt('PPD_SEGMENT_MAX_CARD_CONTINUATION_HEIGHT_PX', 280);
}

/**
 * True only for horizontal card/tile rows (not heroes or generic "promotion" copy).
 */
function isCardLikeLabel(label) {
  const l = (label || '').trim();
  if (!l) return false;
  if (NON_CARD_ROW_LABEL_RE.test(l)) return false;
  return CARD_ROW_LABEL_RE.test(l);
}

function isCardTextFragmentLabel(label) {
  return CARD_TEXT_FRAGMENT_RE.test(label || '');
}

function isIncompleteCardRow(rectPx, label) {
  if (!rectPx || !isCardLikeLabel(label)) return false;
  return rectPx.height < minCardRowHeightPx();
}

function needsCardRowExpansion(seg, remainderHeightPx) {
  if (!seg?.bbox || !isCardLikeLabel(seg.label)) return false;
  const hPx = Math.round(seg.bbox.height * remainderHeightPx);
  if (hPx >= minCardRowHeightPx()) return false;
  if (seg.bbox.height >= 0.55) return false;
  return true;
}

function isCardRowContinuationStrip(label, rectPx) {
  if (!rectPx || rectPx.y > 100) return false;
  if (rectPx.height > maxCardContinuationStripHeightPx()) return false;
  return isCardLikeLabel(label) || isCardTextFragmentLabel(label);
}

function isCardTextFragment(label, rectPx) {
  if (!rectPx || rectPx.height > maxCardTextFragmentHeightPx()) return false;
  if (rectPx.y > 100) return false;
  return isCardTextFragmentLabel(label) || (isCardLikeLabel(label) && rectPx.height < 200);
}

function shouldMergeFragmentIntoPrev(prev, label, rectPx) {
  if (!prev || !prev.segmentBbox || !isCardLikeLabel(prev.label)) return false;
  const prevIncomplete = prev.segmentBbox.height < minCardRowHeightPx();
  if (!isCardRowContinuationStrip(label, rectPx) && !isCardTextFragment(label, rectPx)) {
    return false;
  }
  if (prevIncomplete) return true;
  if (!prev.matchFound) return true;
  return false;
}

/**
 * Extend source bbox modestly toward min card-row height (links directly below images).
 * Capped so a misclassified segment cannot swallow the next section.
 */
function extendIncompleteCardRowBbox(rectFull, remainderHeightPx, label) {
  if (!isIncompleteCardRow(rectFull, label)) return rectFull;
  const maxHeight = remainderHeightPx - rectFull.y;
  const extendCap = rectFull.height + maxCardRowExtendPx();
  const targetHeight = Math.min(
    Math.max(rectFull.height, Math.min(minCardRowHeightPx(), extendCap)),
    maxHeight
  );
  if (targetHeight <= rectFull.height) return rectFull;
  return { ...rectFull, height: targetHeight };
}

function mergeCardFragmentRects(prevSegmentBbox, fragmentRect) {
  const x1 = Math.min(prevSegmentBbox.x, fragmentRect.x);
  const x2 = Math.max(
    prevSegmentBbox.x + prevSegmentBbox.width,
    fragmentRect.x + fragmentRect.width
  );
  return {
    x: x1,
    y: prevSegmentBbox.y,
    width: x2 - x1,
    height: prevSegmentBbox.height + fragmentRect.y + fragmentRect.height,
  };
}

module.exports = {
  CARD_ROW_EXPAND_ADDENDUM,
  cardRowExpandRetryAddendum,
  isCardLikeLabel,
  isCardTextFragment,
  isIncompleteCardRow,
  isCardRowContinuationStrip,
  needsCardRowExpansion,
  shouldMergeFragmentIntoPrev,
  extendIncompleteCardRowBbox,
  mergeCardFragmentRects,
  minCardRowHeightPx,
};
