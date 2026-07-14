/**
 * text-layout-compare — align two text-layout fingerprints (see text-geometry.js)
 * and report where they diverge.
 *
 * Aligns the source and target text sequences by content (LCS), so after a
 * missing/extra run the sequences RE-SYNC when content resembles again — exactly
 * the "drift then recover" the layout idea relies on. Outputs:
 *   - missing: source text not on target (dropped copy) — with source y (where)
 *   - extra:   target text not on source
 *   - divergenceSegments: contiguous mismatch runs with their y-ranges (the
 *     vertical bands to review)
 *   - layoutDrift: matched texts whose gap-to-previous-matched (dy) differs
 *     beyond tolerance — a CSS/positioning signal (text shifts first when CSS
 *     is wrong)
 */

const { normalizeForSubstring } = require('./text-audit');

/** Default text patterns to drop before comparison (page chrome that isn't content). */
const DEFAULT_IGNORE_TEXT = [
  /^text size:?$/i,
  /^letter spacing:?$/i,
  /^[slm]$/i, // the S / M / L font-size toggles
];

/**
 * Match key: case/punctuation/glyph-insensitive (arrows, bullets, trailing
 * punctuation collapse away), after optional recipe normalize rules. Reuses the
 * text-audit substring normalization so "Apply Now →" and "apply now." align.
 */
function matchKeyOf(text, normalizers) {
  let s = String(text || '');
  for (const n of normalizers || []) s = s.replace(n.re, n.to);
  return normalizeForSubstring(s);
}

/** Levenshtein distance, early-exit once it exceeds `max`. */
function boundedLevenshtein(a, b, max) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/**
 * Fuzzy key equality: exact, or a small edit distance for longer strings — so
 * "credit card" == "credit cards" (plural / minor wording) but short strings
 * ("pay" vs "buy") still need an exact match. Disable with fuzzy:false.
 */
function makeKeyEq(opts = {}) {
  if (opts.fuzzy === false) return (a, b) => a === b;
  const minLen = opts.fuzzyMinChars ?? 6;
  const ratio = opts.fuzzyMaxEditRatio ?? 0.15;
  return (a, b) => {
    if (a === b) return true;
    const minL = Math.min(a.length, b.length);
    if (minL < minLen) return false;
    const maxEdits = Math.max(1, Math.floor(minL * ratio));
    return boundedLevenshtein(a, b, maxEdits) <= maxEdits;
  };
}

/** Longest-common-subsequence alignment of two item arrays keyed by `.key`. */
function lcsAlign(a, b, eq = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i].key, b[j].key)
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i].key, b[j].key)) {
      ops.push({ type: 'match', srcIndex: i, tgtIndex: j });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'src-only', srcIndex: i });
      i += 1;
    } else {
      ops.push({ type: 'tgt-only', tgtIndex: j });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: 'src-only', srcIndex: i++ });
  while (j < m) ops.push({ type: 'tgt-only', tgtIndex: j++ });
  return ops;
}

function yRange(items) {
  if (!items.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const it of items) {
    min = Math.min(min, it.y);
    max = Math.max(max, it.y + it.h);
  }
  return { top: min, bottom: max };
}

/** True if `text` matches any ignore pattern (page chrome, not content). */
function isIgnored(text, patterns) {
  return (patterns || []).some((re) => re.test(String(text || '').trim()));
}

/**
 * Reflow reconciliation: within a divergence run, source text that was split/
 * merged across lines differently on the target isn't truly missing — its tokens
 * reappear in the target's extra run at the same spot. If ≥ `coverageMin` of the
 * segment's missing tokens are present in its extra tokens, treat that side as
 * reflowed (not missing/extra).
 */
function reconcileReflow(seg, coverageMin) {
  const missTokens = seg.src.flatMap((it) => it.key.split(' ').filter(Boolean));
  const extraTokens = new Set(seg.tgt.flatMap((it) => it.key.split(' ').filter(Boolean)));
  if (missTokens.length === 0 || extraTokens.size === 0) return false;
  const present = missTokens.filter((t) => extraTokens.has(t)).length;
  return present / missTokens.length >= coverageMin;
}

/**
 * @param {Array} source fingerprint (from buildFingerprint)
 * @param {Array} target fingerprint
 * @param {{ layoutDriftTolerancePx?: number, normalizers?: Array, ignoreTextPatterns?: Array, reflowCoverageMin?: number }} [opts]
 */
function compareTextLayout(source, target, opts = {}) {
  const driftTol = opts.layoutDriftTolerancePx ?? 24;
  const reflowCoverageMin = opts.reflowCoverageMin ?? 0.9;
  const ignorePatterns = opts.ignoreTextPatterns || DEFAULT_IGNORE_TEXT;
  const normalizers = opts.normalizers || [];

  // Preprocess: attach a robust match key and drop ignored chrome.
  const prep = (arr) =>
    arr
      .filter((it) => !isIgnored(it.text, ignorePatterns))
      .map((it) => ({ ...it, key: matchKeyOf(it.text, normalizers) }))
      .filter((it) => it.key.length > 0);
  const src = prep(source);
  const tgt = prep(target);

  const ops = lcsAlign(src, tgt, makeKeyEq(opts));

  const missing = [];
  const extra = [];
  const matched = [];
  const divergenceSegments = [];
  let reflowReconciledSegments = 0;

  // Group consecutive non-match ops into divergence segments.
  let curSeg = null;
  const flush = () => {
    if (!curSeg) return;
    const reflowed = reconcileReflow(curSeg, reflowCoverageMin);
    if (reflowed) {
      // Same text, laid out differently — not a real discrepancy.
      reflowReconciledSegments += 1;
    } else {
      for (const it of curSeg.src) missing.push({ text: it.text, x: it.x, y: it.y });
      for (const it of curSeg.tgt) extra.push({ text: it.text, x: it.x, y: it.y });
      divergenceSegments.push({
        missingCount: curSeg.src.length,
        extraCount: curSeg.tgt.length,
        sourceYRange: yRange(curSeg.src),
        targetYRange: yRange(curSeg.tgt),
        missingSample: curSeg.src.slice(0, 5).map((it) => it.text),
        extraSample: curSeg.tgt.slice(0, 5).map((it) => it.text),
      });
    }
    curSeg = null;
  };

  for (const op of ops) {
    if (op.type === 'match') {
      flush();
      matched.push({ src: src[op.srcIndex], tgt: tgt[op.tgtIndex] });
    } else if (op.type === 'src-only') {
      curSeg = curSeg || { src: [], tgt: [] };
      curSeg.src.push(src[op.srcIndex]);
    } else {
      curSeg = curSeg || { src: [], tgt: [] };
      curSeg.tgt.push(tgt[op.tgtIndex]);
    }
  }
  flush();

  // Layout drift: compare the vertical gap to the previous *matched* item on
  // each side. If a page is styled the same, consecutive matched texts keep the
  // same vertical rhythm; a diverging gap flags a CSS/spacing problem.
  const layoutDrift = [];
  for (let k = 1; k < matched.length; k++) {
    const srcDy = matched[k].src.y - matched[k - 1].src.y;
    const tgtDy = matched[k].tgt.y - matched[k - 1].tgt.y;
    const delta = Math.abs(srcDy - tgtDy);
    if (delta > driftTol) {
      layoutDrift.push({
        text: matched[k].src.text,
        sourceY: matched[k].src.y,
        targetY: matched[k].tgt.y,
        sourceGap: srcDy,
        targetGap: tgtDy,
        gapDelta: delta,
      });
    }
  }

  const sourceCount = src.length;
  const matchedCount = matched.length;
  return {
    status: missing.length ? 'discrepancies' : 'ok',
    sourceTextCount: sourceCount,
    targetTextCount: tgt.length,
    matchedCount,
    missingCount: missing.length,
    extraCount: extra.length,
    coverage: sourceCount > 0 ? matchedCount / sourceCount : 1,
    divergenceSegmentCount: divergenceSegments.length,
    reflowReconciledSegments,
    layoutDriftCount: layoutDrift.length,
    missing,
    extra,
    divergenceSegments,
    layoutDrift,
  };
}

/**
 * Produce indexed item lists for the visual overlay. Source is the master index:
 * matched and missing source items get an integer N (incrementing); the matched
 * target shares N (label "N:0"); target-only (extra) items get "N:k" (k≥1) so a
 * reviewer sees exactly where the target has content the source lacks. Matched
 * items carry `counterpart` = the other side's item (for drawing its box in the
 * other colour at its own coordinates).
 * @returns {{ source: Array, target: Array }}
 */
function alignForOverlay(source, target, opts = {}) {
  const ignorePatterns = opts.ignoreTextPatterns || DEFAULT_IGNORE_TEXT;
  const normalizers = opts.normalizers || [];
  const prep = (arr) =>
    arr
      .filter((it) => !isIgnored(it.text, ignorePatterns))
      .map((it) => ({ ...it, key: matchKeyOf(it.text, normalizers) }))
      .filter((it) => it.key.length > 0);
  const src = prep(source);
  const tgt = prep(target);
  const ops = lcsAlign(src, tgt, makeKeyEq(opts));

  const sourceItems = [];
  const targetItems = [];
  let n = 0;
  let sub = 0;
  for (const op of ops) {
    if (op.type === 'match') {
      n += 1;
      sub = 0;
      const s = src[op.srcIndex];
      const t = tgt[op.tgtIndex];
      sourceItems.push({ ...s, idx: String(n), matched: true, counterpart: t });
      targetItems.push({ ...t, idx: `${n}:0`, matched: true, counterpart: s });
    } else if (op.type === 'src-only') {
      n += 1;
      sub = 0;
      sourceItems.push({ ...src[op.srcIndex], idx: String(n), matched: false, counterpart: null });
    } else {
      sub += 1;
      targetItems.push({ ...tgt[op.tgtIndex], idx: `${n}:${sub}`, matched: false, counterpart: null });
    }
  }
  return { source: sourceItems, target: targetItems };
}

module.exports = { lcsAlign, compareTextLayout, alignForOverlay };
