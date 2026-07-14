/**
 * text-geometry — a deterministic, AI-free "text-layout fingerprint" of a page.
 *
 * Idea: every visible text run has a precise rendered top-left (the tight box of
 * the *text itself*, via a DOM Range — not its container). In reading order, the
 * signed step (dx, dy) from one text to the next is stable when a page is styled
 * correctly. Fingerprinting source and target this way and aligning the two
 * sequences yields: missing / extra text, *where* (vertical band) it diverges,
 * and — because text is the first thing to shift when CSS is wrong — a layout
 * drift signal. No screenshots, no model calls.
 *
 * Extraction runs in the browser (tight Range rects, document coords). Ordering
 * and the delta fingerprint are computed here in Node.
 */

const { normalizeTextLine } = require('./visible-text');

/**
 * Collect visible text runs with their tight rendered rect (document coords).
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{text,x,y,w,h,fontSize}>>}
 */
async function extractTextItemsInBrowser(page) {
  return page.evaluate(() => {
    const items = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const raw = node.nodeValue;
      if (raw && raw.trim().length >= 1) {
        const el = node.parentElement;
        if (el) {
          const st = window.getComputedStyle(el);
          const visible =
            st.display !== 'none' &&
            st.visibility !== 'hidden' &&
            parseFloat(st.opacity || '1') >= 0.05;
          if (visible) {
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            if (rect.width >= 2 && rect.height >= 2) {
              items.push({
                text: raw.replace(/\s+/g, ' ').trim(),
                x: Math.round(rect.left + window.scrollX),
                y: Math.round(rect.top + window.scrollY),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                fontSize: Math.round(parseFloat(st.fontSize) || 0),
              });
            }
          }
        }
      }
      node = walker.nextNode();
    }
    return items;
  });
}

/**
 * Put raw text items into reading order: top-to-bottom by line, left-to-right
 * within a line. Two items share a line when their vertical centers are within
 * `lineTol` px (defaults to ~60% of the median text height).
 */
function toReadingOrder(items, lineTol) {
  const withMid = items.map((it) => ({ ...it, mid: it.y + it.h / 2 }));
  const heights = withMid.map((i) => i.h).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 16;
  const tol = lineTol ?? Math.max(6, Math.round(medianH * 0.6));
  // Sort by y first so we can group into lines.
  withMid.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of withMid) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(it.mid - line.mid) <= tol) {
      line.items.push(it);
      // running line center
      line.mid = (line.mid * (line.items.length - 1) + it.mid) / line.items.length;
    } else {
      lines.push({ mid: it.mid, items: [it] });
    }
  }
  const ordered = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    for (const it of line.items) ordered.push(it);
  }
  return ordered;
}

/**
 * Build the fingerprint: ordered text items each annotated with the signed step
 * (dx, dy) from the previous item, plus a normalized text key for alignment.
 * @param {Array} rawItems output of extractTextItemsInBrowser
 * @param {{ minChars?: number, lineTol?: number }} [opts]
 */
function buildFingerprint(rawItems, opts = {}) {
  const minChars = opts.minChars ?? 1;
  const cleaned = [];
  const seen = new Set();
  for (const it of rawItems || []) {
    const norm = normalizeTextLine(it.text);
    if (!norm || norm.length < minChars) continue;
    // De-dupe exact (text,x,y) repeats (some nodes double-report).
    const key = `${norm}@${it.x},${it.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ ...it, norm });
  }
  const ordered = toReadingOrder(cleaned, opts.lineTol);
  return ordered.map((it, i) => {
    const prev = ordered[i - 1];
    return {
      index: i,
      text: it.text,
      norm: it.norm,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      fontSize: it.fontSize,
      dx: prev ? it.x - prev.x : 0,
      dy: prev ? it.y - prev.y : 0,
    };
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @returns {Promise<Array>} fingerprint items
 */
async function extractTextFingerprint(page, opts = {}) {
  const raw = await extractTextItemsInBrowser(page);
  return buildFingerprint(raw, opts);
}

module.exports = {
  extractTextItemsInBrowser,
  toReadingOrder,
  buildFingerprint,
  extractTextFingerprint,
};
