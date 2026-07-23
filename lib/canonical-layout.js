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
  // JSON-string transport: the big object return throws on anti-bot pages that
  // tamper with Symbol.hasInstance (breaks Playwright's structured serialization,
  // failing the whole base capture on a poisoned load). See memory: crawl-hard-cases.
  const json = await page.evaluate(async () => {
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
    // Collapsed <details> (the standard EDS accordion, class "accordion-item"):
    // a closed <details> paints ONLY its <summary> — the rest keeps full layout
    // boxes and computes as visible, so it evades the checks above and leaks the
    // collapsed content into the pear (a screenshot correctly shows it hidden).
    // Treat any node under a closed <details> as hidden unless it's in the summary.
    const isInClosedDetails = (el) => {
      for (let p = el; p; p = p.parentElement) {
        if (p.tagName === 'DETAILS' && !p.hasAttribute('open')) {
          const summary = p.querySelector(':scope > summary');
          if (!summary || !summary.contains(el)) return true;
        }
      }
      return false;
    };

    // --- Text runs: one box per text node (tight Range rect, document coords).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.nodeValue;
      if (!raw || !raw.trim()) continue;
      const el = node.parentElement;
      if (!el || anyHiddenAncestor(el) || isHiddenByClipOrOffscreen(el) || isInClosedDetails(el)) continue;
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
        // Rendered text may be transformed by CSS (e.g. text-transform:uppercase
        // over a lower-case DOM node) — capture it so the pear matches the page.
        textTransform: st.textTransform,
        fontVariant: st.fontVariantCaps || st.fontVariant,
      });
    }

    // --- Replaced / media elements → image placeholders in the pear.
    const mediaSel = 'img, svg, video, canvas, input, textarea, select';
    document.querySelectorAll(mediaSel).forEach((el) => {
      // Skip <svg> nested inside another <svg> (only the outer counts).
      if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) return;
      if (anyHiddenAncestor(el) || isHiddenByClipOrOffscreen(el) || isInClosedDetails(el)) return;
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
      if (anyHiddenAncestor(el) || isHiddenByClipOrOffscreen(el) || isInClosedDetails(el)) return;
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

    // --- Clickable element regions (actionability). Semantic triggers + any
    // element tagged with a direct click listener by the capture instrumentation
    // ([data-ppd-click]). Delegated listeners on document can't be attributed to
    // an element, so this is best-effort. Keep only the outermost clickable of a
    // nesting (an <a> wrapping spans → one region), visible and on-page.
    const CLICK_SEL =
      'a[href],button,summary,[role=button],[role=tab],[role=menuitem],[onclick],[aria-expanded],[aria-controls],[data-ppd-click]';
    // Item-type click targets (carousel cards, tabs, pagination bullets) are
    // individually clickable even when nested in a container that carries a
    // DELEGATED click listener (so the whole swiper matched CLICK_SEL via
    // data-ppd-click). Mirrors the crawl's ITEM_SEL so a card row yields one box
    // PER CARD, not one big box spanning all cards centred on the middle one.
    const ITEM_SEL = '.swiper-slide,[role=tab],.swiper-pagination-bullet';
    const clickables = [];
    const pushed = new Set();
    const pushClk = (el) => {
      if (pushed.has(el)) return;
      if (anyHiddenAncestor(el) || isHiddenByClipOrOffscreen(el) || isInClosedDetails(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6) return;
      pushed.add(el);
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      clickables.push({
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        type: href ? 'link' : el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls') ? 'toggle' : 'action',
        href: href || null,
        // Same derivation as the crawl's trigger label, so a drifted crawl
        // trigger (captured on a separate page load) can be snapped back onto
        // this base clickable — whose coordinates match the rendered pear.
        label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    };
    // Individual item cards/tabs/bullets first (bypass outermost-only).
    document.querySelectorAll(ITEM_SEL).forEach(pushClk);
    // Then other clickables: outermost-only, and SKIP a container that merely
    // wraps item-type children (a delegated carousel) — its cards above are the
    // real click targets, so we don't also emit the whole-row container box.
    document.querySelectorAll(CLICK_SEL).forEach((el) => {
      if (el.parentElement && el.parentElement.closest(CLICK_SEL)) return; // outermost only
      if (el.querySelector(ITEM_SEL)) return; // carousel/tabs container → its items are the clickables
      pushClk(el);
    });

    // Collect the page's web fonts so the pear renders in the real typeface —
    // font metrics drive line wrapping, so a substitute font can wrap text
    // differently and mislead. Fonts are fetched HERE (same-origin as the page,
    // so no CORS block) and inlined as base64 data-URIs, so the pear renders
    // them anywhere, offline, with no cross-origin fetch at view time. Only the
    // families actually used by text nodes are embedded, under a byte budget.
    const usedFamilies = new Set();
    for (const n of nodes) {
      if (n.kind !== 'text' || !n.font) continue;
      for (const f of n.font.split(',')) {
        usedFamilies.add(f.trim().replace(/^["']|["']$/g, '').toLowerCase());
      }
    }
    let budget = 3 * 1024 * 1024; // cap total embedded font bytes
    const inlineUrls = async (cssText, base) => {
      let out = cssText;
      for (const m of [...cssText.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]) {
        let abs;
        try {
          abs = new URL(m[2], base).href;
        } catch {
          continue;
        }
        if (/^data:/.test(abs) || budget <= 0) continue;
        try {
          const resp = await fetch(abs);
          if (!resp.ok) continue;
          const buf = await resp.arrayBuffer();
          if (buf.byteLength > budget) continue;
          budget -= buf.byteLength;
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const mime = /\.woff2/i.test(abs)
            ? 'font/woff2'
            : /\.woff/i.test(abs)
              ? 'font/woff'
              : /\.ttf/i.test(abs)
                ? 'font/ttf'
                : 'font/otf';
          out = out.replace(m[0], `url("data:${mime};base64,${btoa(bin)}")`);
        } catch {
          /* skip unfetchable font */
        }
      }
      return out;
    };
    const fontFaces = [];
    const fontLinks = [];
    for (const sheet of document.styleSheets) {
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch {
        // Cross-origin sheet — can't read rules; re-link known font providers.
        if (sheet.href && /fonts\.googleapis|fonts\.gstatic|use\.typekit|typekit\.net/i.test(sheet.href)) {
          fontLinks.push(sheet.href);
        }
        continue;
      }
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.type !== 5 /* CSSRule.FONT_FACE_RULE */) continue;
        const fam = (rule.style.getPropertyValue('font-family') || '')
          .replace(/["']/g, '')
          .trim()
          .toLowerCase();
        if (!usedFamilies.has(fam)) continue; // only fonts the text actually uses
        if (budget <= 0) break;
        fontFaces.push(await inlineUrls(rule.cssText, sheet.href || document.baseURI));
      }
    }
    return JSON.stringify({
      url: location.href,
      width: docW,
      height: docH,
      nodes,
      clickables,
      fonts: { faces: fontFaces.join('\n'), links: [...new Set(fontLinks)] },
    });
  });
  return json ? JSON.parse(json) : null;
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
        `text-transform:${esc(n.textTransform || 'none')};font-variant:${esc(n.fontVariant || 'normal')};` +
        // Single-line labels (box ~one line tall) must not wrap — a hair of
        // rounding in the captured width would otherwise push the last word to a
        // 2nd line and clip it. Multi-line text keeps normal wrapping.
        `overflow:hidden;white-space:${n.h <= (n.fontSize || 16) * 1.7 ? 'nowrap' : 'normal'};` +
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

/**
 * `<head>` markup that loads a CLM's captured web fonts (provider stylesheet
 * links + inline @font-face). Best-effort: fonts served with permissive CORS
 * (Google Fonts etc.) load; self-hosted fonts without CORS fall back to system.
 */
function fontHead(fonts) {
  if (!fonts) return '';
  const links = (fonts.links || [])
    .map((h) => `<link rel="stylesheet" href="${esc(h)}">`)
    .join('\n');
  const faces = fonts.faces ? `<style>${fonts.faces.replace(/<\/style/gi, '<\\/style')}</style>` : '';
  return `${links}\n${faces}`;
}

/** Render a CLM to a self-contained standalone "pear" page. */
function renderPearHtml(clm, opts = {}) {
  const title = opts.title || 'pear';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
${fontHead(clm.fonts)}
<style>
  html,body{margin:0;padding:0;background:#fff}
  #canvas{position:relative;width:${clm.width}px;height:${clm.height}px;background:#fff}
</style></head><body>
<div id="canvas">
${renderPearNodes(clm)}
</div>
</body></html>`;
}

module.exports = { extractCanonicalLayout, renderPearHtml, renderPearNodes, fontHead };
