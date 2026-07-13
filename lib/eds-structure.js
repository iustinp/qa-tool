/**
 * eds-structure — parse the block structure of an Adobe EDS page directly from
 * the DOM (no AI). The migration target is always EDS, which decorates content
 * into a predictable shape: content lives in <main>, split into sections
 * (`main > div`), and blocks are `<div data-block-name="…" class="… block">`.
 *
 * This gives us the target's block regions + text for free, so later slices can
 * match source blocks against structurally-parsed target blocks instead of
 * asking vision to locate each one — the "exploit the always-EDS target"
 * shortcut from the roadmap. This module only extracts; wiring it into the match
 * loop is a separate slice.
 */

/**
 * Extract EDS blocks from a Playwright page. Returns document-pixel bounding
 * boxes (top-left origin), aligned with the full-page screenshot space.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ isEds: boolean, sectionCount: number, blocks: Array }>}
 */
async function extractEdsBlocks(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return { isEds: false, sectionCount: 0, blocks: [] };

    // EDS marks decorated blocks with data-block-name; .block is a fallback for
    // pages captured mid-decoration. data-block-name presence is the EDS signal.
    const isEds = main.querySelector('[data-block-name]') != null;
    const sections = Array.from(main.children).filter((el) => el.nodeType === 1);

    const seen = new Set();
    const blocks = [];
    let index = 0;
    for (const el of main.querySelectorAll('[data-block-name], .block')) {
      if (seen.has(el)) continue;
      seen.add(el);
      // Skip blocks nested inside another matched block (keep top-level blocks).
      if (el.parentElement && el.parentElement.closest('[data-block-name], .block')) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const name =
        el.getAttribute('data-block-name') ||
        Array.from(el.classList).find((c) => c !== 'block') ||
        'block';
      const lines = (el.innerText || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      blocks.push({
        index: index++,
        blockName: name,
        bbox: {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        textLineCount: lines.length,
      });
    }
    // Document order top-to-bottom (querySelectorAll is already DOM order, but
    // absolutely-positioned blocks can reorder visually).
    blocks.sort((a, b) => a.bbox.y - b.bbox.y);
    blocks.forEach((b, i) => {
      b.index = i;
    });
    return { isEds, sectionCount: sections.length, blocks };
  });
}

/** Buffer-free summary for artifacts. */
function summarizeEdsStructure(eds) {
  if (!eds) return null;
  return {
    isEds: eds.isEds,
    sectionCount: eds.sectionCount,
    blockCount: eds.blocks.length,
    blockNames: eds.blocks.map((b) => b.blockName),
  };
}

module.exports = {
  extractEdsBlocks,
  summarizeEdsStructure,
};
