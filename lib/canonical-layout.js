/**
 * canonical-layout — reduce any page, whatever its DOM, to a flat "Canonical
 * Layout Model" (CLM): just the rendered *leaves* (text runs, images) each
 * placed at its absolute document x/y/w/h with the styling it actually renders
 * with. Two pages built from wildly different markup ("apples and oranges")
 * both collapse to the same shape of data — two "pears" — which we can then
 * compare on position + content instead of DOM structure.
 *
 * Why this dodges the fixed/sticky bug: getBoundingClientRect at scrollTop=0
 * already yields correct document coordinates for every element (even below the
 * fold). The old overlay looked wrong only because we drew those coordinates on
 * top of the *stitched screenshot*, where Playwright had painted travelling
 * fixed/sticky bars elsewhere. Here we render our OWN page from the same
 * coordinates, so the model and its backdrop can never disagree.
 *
 * Extraction runs in the browser; rendering the pear is pure Node/string.
 */

/**
 * Collect the canonical leaves of the currently-loaded page. Must run with the
 * page scrolled to the top (captureFullPageBuffer's stabilize step does this).
 * @param {import('playwright').Page} page
 * @returns {Promise<{url,width,height,nodes:Array}>}
 */
async function extractCanonicalLayout(page) {
  return page.evaluate(() => {
    const nodes = [];
    const doc = document.documentElement;
    const docW = Math.max(doc.scrollWidth, window.innerWidth);
    const docH = Math.max(doc.scrollHeight, doc.offsetHeight);
    const isVisible = (el) => {
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (parseFloat(st.opacity || '1') < 0.05) return false;
      return true;
    };
    const anyHiddenAncestor = (el) => {
      for (let p = el; p; p = p.parentElement) {
        if (p.nodeType === 1 && !isVisible(p)) return true;
      }
      return false;
    };
    // Rendered-but-not-shown: content that computes as visible yet is clipped
    // away by a collapsed/overflow-hidden ancestor (flyout & mega-menus, "read
    // more" panels) or pushed off the page. These leak into the model and
    // create phantom diffs, so drop anything with no on-page footprint.
    const clips = (v) => v === 'hidden' || v === 'clip';
    const isHiddenByClipOrOffscreen = (el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + window.scrollX;
      const y = r.top + window.scrollY;
      // Off the document (negative/again-beyond) — e.g. left:-9999px hiding.
      if (x + r.width <= 1 || y + r.height <= 1 || x >= docW - 1 || y >= docH - 1) return true;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const st = window.getComputedStyle(p);
        if (!clips(st.overflowX) && !clips(st.overflowY)) continue;
        const pr = p.getBoundingClientRect();
        // Meaningful overlap between the element and its clipping ancestor?
        const iw = Math.min(r.right, pr.right) - Math.max(r.left, pr.left);
        const ih = Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top);
        if (iw <= 1 || ih <= 1) return true; // clipped out (e.g. max-height:0 menu)
      }
      return false;
    };

    // --- Text runs: one box per text node (tight Range rect, document coords).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.nodeValue;
      if (!raw || !raw.trim()) continue;
      const el = node.parentElement;
      if (!el || anyHiddenAncestor(el) || isHiddenByClipOrOffscreen(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const st = window.getComputedStyle(el);
      nodes.push({
        kind: 'text',
        text: raw.replace(/\s+/g, ' ').trim(),
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        position: st.position,
        font: st.fontFamily,
        fontSize: Math.round(parseFloat(st.fontSize) || 0),
        fontWeight: st.fontWeight,
        fontStyle: st.fontStyle,
        color: st.color,
        align: st.textAlign,
        lineHeight: st.lineHeight,
        letterSpacing: st.letterSpacing,
      });
    }

    // --- Replaced / media elements → image placeholders in the pear.
    const mediaSel = 'img, svg, video, canvas, input, textarea, select';
    document.querySelectorAll(mediaSel).forEach((el) => {
      // Skip <svg> nested inside another <svg> (only the outer counts).
      if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) return;
      if (anyHiddenAncestor(el) || isHiddenByClipOrOffscreen(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      const st = window.getComputedStyle(el);
      nodes.push({
        kind: 'image',
        tag: el.tagName.toLowerCase(),
        src: el.currentSrc || el.getAttribute('src') || '',
        alt: el.getAttribute('alt') || '',
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        position: st.position,
      });
    });

    // --- Leaf elements painted purely via background-image (icons, hero art).
    document.querySelectorAll('*').forEach((el) => {
      if (el.childElementCount !== 0) return; // leaf only, avoid huge containers
      if ((el.textContent || '').trim()) return; // text handled above
      const st = window.getComputedStyle(el);
      if (!st.backgroundImage || st.backgroundImage === 'none') return;
      if (anyHiddenAncestor(el) || isHiddenByClipOrOffscreen(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) return;
      const m = st.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      nodes.push({
        kind: 'bg-image',
        src: m ? m[1] : '',
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        position: st.position,
      });
    });

    return { url: location.href, width: docW, height: docH, nodes };
  });
}

const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );

/**
 * Render a CLM to a self-contained "pear": a page-sized canvas with every leaf
 * absolutely positioned. Text uses its captured font/size/weight/colour so it
 * wraps in-box like the original; images/backgrounds become labelled
 * placeholders. Fixed/sticky leaves get a dashed outline so they're spottable.
 * @param {{url,width,height,nodes}} clm
 */
/** Relative luminance (0..1) of a computed CSS color string, or null. */
function luminance(color) {
  const m = String(color).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a] = m[1].split(',').map((v) => parseFloat(v));
  if (a != null && a < 0.05) return null; // transparent — unknown
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Render just the positioned leaves of a CLM (no page wrapper) — the reusable
 * "canvas" contents shared by the standalone pear and the review overlay.
 * @returns {string} HTML of absolutely-positioned children
 */
function renderPearNodes(clm) {
  // Layer order matters: paint images/backgrounds first so text (added last)
  // always sits on top and stays readable — the target's full-bleed hero image
  // otherwise buries the copy under it.
  const imgParts = [];
  const textParts = [];
  for (const n of clm.nodes) {
    const posFlag = n.position === 'fixed' || n.position === 'sticky';
    const base = `position:absolute;left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;`;
    if (n.kind === 'text') {
      // Near-white / very light text would vanish on the white canvas; drop a
      // dark chip behind it so it reads while keeping its true colour.
      const lum = luminance(n.color);
      const lightText = lum != null && lum > 0.7;
      const style =
        base +
        `font-family:${esc(n.font)};font-size:${n.fontSize}px;font-weight:${esc(n.fontWeight)};` +
        `font-style:${esc(n.fontStyle)};color:${esc(n.color)};text-align:${esc(n.align)};` +
        `line-height:${esc(n.lineHeight)};letter-spacing:${esc(n.letterSpacing)};` +
        `overflow:hidden;white-space:normal;` +
        (lightText ? 'background:#333;' : '') +
        (posFlag ? 'outline:1px dashed #f80;' : '');
      textParts.push(
        `<div class="t" style="${style}" title="${esc(n.position)}">${esc(n.text)}</div>`
      );
    } else {
      const label = n.kind === 'bg-image' ? 'bg' : n.tag || 'img';
      const style =
        base +
        `background:rgba(120,150,190,0.10);border:1px solid rgba(120,150,190,0.5);` +
        `box-sizing:border-box;font:10px/1.2 monospace;color:#6b7a90;padding:2px;overflow:hidden;` +
        (posFlag ? 'outline:1px dashed #f80;' : '');
      imgParts.push(
        `<div class="i" style="${style}" title="${esc(n.src)}">${esc(label)}${
          n.alt ? ' · ' + esc(n.alt.slice(0, 40)) : ''
        }</div>`
      );
    }
  }
  return imgParts.join('\n') + '\n' + textParts.join('\n');
}

/** Render a CLM to a self-contained standalone "pear" page. */
function renderPearHtml(clm, opts = {}) {
  const title = opts.title || 'pear';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  html,body{margin:0;padding:0;background:#fff}
  #canvas{position:relative;width:${clm.width}px;height:${clm.height}px;background:#fff}
</style></head><body>
<div id="canvas">
${renderPearNodes(clm)}
</div>
</body></html>`;
}

module.exports = { extractCanonicalLayout, renderPearHtml, renderPearNodes };
