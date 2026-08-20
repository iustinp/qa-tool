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

/** Attach a match key and drop ignored chrome — shared by both comparators. */
function prepItems(arr, opts = {}) {
  const ignorePatterns = opts.ignoreTextPatterns || DEFAULT_IGNORE_TEXT;
  const normalizers = opts.normalizers || [];
  return arr
    .filter((it) => !isIgnored(it.text, ignorePatterns))
    .map((it) => ({ ...it, key: matchKeyOf(it.text, normalizers) }))
    .filter((it) => it.key.length > 0);
}

/**
 * The single alignment pass both the audit summary and the overlay derive from,
 * so their counts can never drift apart. Tags every prepped item with a status:
 *   matched — 1:1 LCS match          reflow  — same text re-split across lines
 *   moved   — matched out of order   missing — source only   extra — target only
 * Items also carry `counterpart` (the paired item) where one exists.
 * @param {Array} src prepped source items  @param {Array} tgt prepped target items
 */
function annotateAlignment(src, tgt, opts = {}) {
  const reflowCoverageMin = opts.reflowCoverageMin ?? 0.9;
  const ops = lcsAlign(src, tgt, makeKeyEq(opts));
  const sItems = src.map((it) => ({ ...it, status: null, counterpart: null }));
  const tItems = tgt.map((it) => ({ ...it, status: null, counterpart: null }));
  const matched = [];
  const divergenceSegments = [];
  let reflowReconciledSegments = 0;

  // Group consecutive non-match ops into divergence segments; reconcile reflow.
  let seg = null;
  const flush = () => {
    if (!seg) return;
    if (reconcileReflow(seg, reflowCoverageMin)) {
      reflowReconciledSegments += 1;
      // Same text, re-split across lines (no clean 1:1 match). Still pair the
      // items up (by order, clamped) so the overlay can treat them like a match
      // — draw a connector and let a click sync/anchor on them.
      const S = seg.src;
      const T = seg.tgt;
      // The group's first elements on each side — a click anywhere in the group
      // syncs by aligning these (not the clicked item), so the whole re-split
      // block lands correctly instead of drifting by the clicked item's offset.
      const groupFirst = { sx: S[0].x, sy: S[0].y, tx: T[0].x, ty: T[0].y };
      S.forEach((it, k) => {
        it.status = 'reflow';
        it.counterpart = T[Math.min(k, T.length - 1)];
        it.groupFirst = groupFirst;
      });
      T.forEach((it, k) => {
        it.status = 'reflow';
        it.counterpart = S[Math.min(k, S.length - 1)];
        it.groupFirst = groupFirst;
      });
    } else {
      for (const it of seg.src) it.status = 'missing';
      for (const it of seg.tgt) it.status = 'extra';
      divergenceSegments.push({
        missingCount: seg.src.length,
        extraCount: seg.tgt.length,
        sourceYRange: yRange(seg.src),
        targetYRange: yRange(seg.tgt),
        missingSample: seg.src.slice(0, 5).map((it) => it.text),
        extraSample: seg.tgt.slice(0, 5).map((it) => it.text),
      });
    }
    seg = null;
  };
  for (const op of ops) {
    if (op.type === 'match') {
      flush();
      const s = sItems[op.srcIndex];
      const t = tItems[op.tgtIndex];
      s.status = 'matched';
      s.counterpart = t;
      t.status = 'matched';
      t.counterpart = s;
      matched.push({ src: s, tgt: t });
    } else if (op.type === 'src-only') {
      seg = seg || { src: [], tgt: [] };
      seg.src.push(sItems[op.srcIndex]);
    } else {
      seg = seg || { src: [], tgt: [] };
      seg.tgt.push(tItems[op.tgtIndex]);
    }
  }
  flush();

  // Relocated-match reconciliation: a leftover `missing` source item whose text also
  // appears as a leftover `extra` target item is PRESENT, just relocated. Pair them
  // and count as MATCHED (not missing + extra) so content completeness isn't double-
  // penalised; the position change then surfaces as DRIFT — the single positional
  // signal. (We retired the separate "moved" bucket: it was redundant to drift and
  // over-fired on duplicate strings.) Prefer the NEAREST equal-text candidate, so a
  // common string ("Read more") pairs with its true instance rather than a distant
  // duplicate — that mis-pairing both produced false "moved" AND corrupted the drift
  // counterpart the pair feeds.
  const eq = makeKeyEq(opts);
  const freeExtra = tItems.filter((t) => t.status === 'extra');
  const usedT = new Set();
  for (const s of sItems) {
    if (s.status !== 'missing') continue;
    let best = null;
    let bestD = Infinity;
    for (const c of freeExtra) {
      if (usedT.has(c) || !eq(s.key, c.key)) continue;
      const d = Math.abs(c.x - s.x) + Math.abs(c.y - s.y); // nearest by position
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) {
      usedT.add(best);
      s.status = 'matched';
      s.counterpart = best;
      best.status = 'matched';
      best.counterpart = s;
      matched.push({ src: s, tgt: best });
    }
  }
  return { ops, sItems, tItems, matched, divergenceSegments, reflowReconciledSegments };
}

/**
 * Per-element positional drift over matched pairs, bucketed green/yellow/red. Each
 * pair's source→target shift is compared to the MEDIAN shift of its K nearest
 * neighbours (by source-Y): a uniformly shifted page cancels to ~0 (harmless
 * cumulative drift), and only an element out of step with its neighbourhood spikes.
 * drift = max(|Δx − medΔx|, |Δy − medΔy|). Thresholds mirror the review's connector
 * colours, so the score and the colours always agree.
 */
function driftBuckets(matched, opts = {}) {
  const good = opts.driftGoodPx ?? 20;
  const okish = opts.driftOkishPx ?? 40;
  const K = opts.driftNeighbours ?? 10;
  const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const items = matched.map((p) => ({ y: p.src.y, dx: p.tgt.x - p.src.x, dy: p.tgt.y - p.src.y }));
  let green = 0;
  let yellow = 0;
  let red = 0;
  for (const it of items) {
    const near = items.filter((o) => o !== it).sort((a, b) => Math.abs(a.y - it.y) - Math.abs(b.y - it.y)).slice(0, K);
    let d = 0;
    if (near.length) {
      const mdx = med(near.map((o) => o.dx));
      const mdy = med(near.map((o) => o.dy));
      d = Math.max(Math.abs(it.dx - mdx), Math.abs(it.dy - mdy));
    }
    if (d <= good) green += 1;
    else if (d <= okish) yellow += 1;
    else red += 1;
  }
  return { green, yellow, red, total: items.length };
}

/**
 * @param {Array} source fingerprint (from buildFingerprint)
 * @param {Array} target fingerprint
 * @param {{ layoutDriftTolerancePx?: number, normalizers?: Array, ignoreTextPatterns?: Array, reflowCoverageMin?: number }} [opts]
 */
function compareTextLayout(source, target, opts = {}) {
  const driftTol = opts.layoutDriftTolerancePx ?? 24;
  const src = prepItems(source, opts);
  const tgt = prepItems(target, opts);
  const { sItems, tItems, matched, divergenceSegments, reflowReconciledSegments } =
    annotateAlignment(src, tgt, opts);

  const missing = sItems
    .filter((it) => it.status === 'missing')
    .map((it) => ({ text: it.text, x: it.x, y: it.y, key: it.key }));
  const extra = tItems
    .filter((it) => it.status === 'extra')
    .map((it) => ({ text: it.text, x: it.x, y: it.y, key: it.key }));

  // Legacy vertical-rhythm drift (gap-to-previous). Superseded for the headline by
  // the neighbour-relative driftBuckets below, but kept as a field for existing
  // report consumers. Iterate a Y-sorted copy so relocated matches (appended out of
  // order) don't inject bogus gaps.
  const seqMatched = [...matched].sort((a, b) => a.src.y - b.src.y);
  const layoutDrift = [];
  for (let k = 1; k < seqMatched.length; k++) {
    const srcDy = seqMatched[k].src.y - seqMatched[k - 1].src.y;
    const tgtDy = seqMatched[k].tgt.y - seqMatched[k - 1].tgt.y;
    const delta = Math.abs(srcDy - tgtDy);
    if (delta > driftTol) layoutDrift.push({ text: seqMatched[k].src.text, sourceY: seqMatched[k].src.y, targetY: seqMatched[k].tgt.y, gapDelta: delta });
  }

  const sourceCount = src.length;
  const matchedCount = matched.length;

  // ── SCORES (0-100) ───────────────────────────────────────────────────────────
  // Direction follows how a human reads each metric:
  //   healthScore, contentScore  — HIGHER = BETTER (100 = perfect / fully complete)
  //   driftScore                 — HIGHER = WORSE  (0 = no drift; drift is a defect)
  // Internally we compute "badness" (0 = perfect) and flip the positive ones.
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  // Drift badness = weighted ordinal mean of the R/Y/G buckets (green 0, yellow 1,
  // red 2), scaled to 100. A single red always nudges it up (never lost to rounding).
  const buckets = driftBuckets(matched, opts);
  const dTot = buckets.total || 1;
  const driftScore = buckets.total ? clamp(50 * (buckets.yellow + 2 * buckets.red) / dTot) : 0;
  // Content badness = same weighted-ordinal idea over SOURCE lines — missing 2,
  // extra 1, matched 0 — so a completeness loss always outweighs equal extra.
  const missPct = sourceCount ? (100 * missing.length) / sourceCount : 0;
  const extraPct = sourceCount ? (100 * extra.length) / sourceCount : (extra.length ? 100 : 0);
  const contentBadness = clamp((2 * missPct + extraPct) / 2);
  const contentScore = 100 - contentBadness; // completeness: higher = better
  const healthScore = 100 - clamp(0.7 * contentBadness + 0.3 * driftScore); // higher = better

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
    // Health scores + drift buckets. healthScore/contentScore HIGHER = BETTER;
    // driftScore HIGHER = WORSE. (Text-only — images are not folded in yet.)
    healthScore,
    driftScore,
    contentScore,
    driftGreen: buckets.green,
    driftYellow: buckets.yellow,
    driftRed: buckets.red,
    // Retired: "moved" is folded into matched (present, relocated) + surfaced as drift.
    movedCount: 0,
    layoutDriftCount: layoutDrift.length,
    missing,
    extra,
    moved: [],
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
  const src = prepItems(source, opts);
  const tgt = prepItems(target, opts);
  const { ops, sItems, tItems } = annotateAlignment(src, tgt, opts);

  // An item is "present" (drawn aligned, not missing/extra) when it matched or
  // was reconciled as reflow — the content is on both pages, just possibly
  // re-laid-out. Only true source-only / target-only items stay missing / extra.
  const overlayItem = (it, idx) => {
    const c = it.counterpart;
    return {
      ...it,
      idx,
      matched: it.status === 'matched' || it.status === 'reflow',
      moved: it.status === 'moved',
      counterpart: c ? { x: c.x, y: c.y, w: c.w, h: c.h, text: c.text } : null,
    };
  };

  // Walk ops for the N / N:k index scheme; pull each item's status from the
  // shared pass so the overlay's missing/moved/extra match the audit exactly.
  const sourceItems = [];
  const targetItems = [];
  let n = 0;
  let sub = 0;
  for (const op of ops) {
    if (op.type === 'match') {
      n += 1;
      sub = 0;
      sourceItems.push(overlayItem(sItems[op.srcIndex], String(n)));
      targetItems.push(overlayItem(tItems[op.tgtIndex], `${n}:0`));
    } else if (op.type === 'src-only') {
      n += 1;
      sub = 0;
      sourceItems.push(overlayItem(sItems[op.srcIndex], String(n)));
    } else {
      sub += 1;
      targetItems.push(overlayItem(tItems[op.tgtIndex], `${n}:${sub}`));
    }
  }
  return { source: sourceItems, target: targetItems };
}

module.exports = { lcsAlign, compareTextLayout, alignForOverlay };
