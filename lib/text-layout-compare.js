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

/** Longest-common-subsequence alignment of two item arrays keyed by `.norm`. */
function lcsAlign(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i].norm === b[j].norm
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].norm === b[j].norm) {
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

/**
 * @param {Array} source fingerprint (from buildFingerprint)
 * @param {Array} target fingerprint
 * @param {{ layoutDriftTolerancePx?: number }} [opts]
 */
function compareTextLayout(source, target, opts = {}) {
  const driftTol = opts.layoutDriftTolerancePx ?? 24;
  const ops = lcsAlign(source, target);

  const missing = [];
  const extra = [];
  const matched = [];
  const divergenceSegments = [];

  // Group consecutive non-match ops into divergence segments.
  let curSeg = null;
  const flush = () => {
    if (!curSeg) return;
    divergenceSegments.push({
      missingCount: curSeg.src.length,
      extraCount: curSeg.tgt.length,
      sourceYRange: yRange(curSeg.src),
      targetYRange: yRange(curSeg.tgt),
      missingSample: curSeg.src.slice(0, 5).map((it) => it.text),
      extraSample: curSeg.tgt.slice(0, 5).map((it) => it.text),
    });
    curSeg = null;
  };

  for (const op of ops) {
    if (op.type === 'match') {
      flush();
      matched.push({ src: source[op.srcIndex], tgt: target[op.tgtIndex] });
    } else if (op.type === 'src-only') {
      const it = source[op.srcIndex];
      missing.push({ text: it.text, x: it.x, y: it.y });
      curSeg = curSeg || { src: [], tgt: [] };
      curSeg.src.push(it);
    } else {
      const it = target[op.tgtIndex];
      extra.push({ text: it.text, x: it.x, y: it.y });
      curSeg = curSeg || { src: [], tgt: [] };
      curSeg.tgt.push(it);
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

  const sourceCount = source.length;
  const matchedCount = matched.length;
  return {
    status: missing.length ? 'discrepancies' : 'ok',
    sourceTextCount: sourceCount,
    targetTextCount: target.length,
    matchedCount,
    missingCount: missing.length,
    extraCount: extra.length,
    coverage: sourceCount > 0 ? matchedCount / sourceCount : 1,
    divergenceSegmentCount: divergenceSegments.length,
    layoutDriftCount: layoutDrift.length,
    missing,
    extra,
    divergenceSegments,
    layoutDrift,
  };
}

module.exports = { lcsAlign, compareTextLayout };
