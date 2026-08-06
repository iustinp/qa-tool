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
    // Carousel/strip item click targets — detected FRAMEWORK-BLIND (was the
    // `.swiper-*` ITEM_SEL): the items of any horizontal SCROLL CONTAINER (clips
    // overflow-x + content wider than its box). Descend the single-child chain to
    // the inner track, take its sizable children. SAME rule as the crawl's
    // tagTriggers, so the pear's per-CARD clickable boxes match the crawl (one box
    // per card, not one big box spanning the row centred on the middle card).
    const scrollContainers = new Set();
    const scrollItems = new Set();
    for (const el of document.querySelectorAll('*')) {
      if (el === document.documentElement || el === document.body) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll|hidden|clip)/.test(cs.overflowX)) continue; // clips horizontally (a carousel does; `clip` = modern EDS)
      if (el.clientWidth < 40) continue;
      // Gate to actual carousels (not generic clipped grids/image crops, which explode the
      // trigger count): it must OVERFLOW horizontally, or carry a delegated click listener
      // (data-ppd-click — the site made it interactive, cards opening a modal).
      if (el.scrollWidth <= el.clientWidth + 2 && !el.hasAttribute('data-ppd-click')) continue;
      // Find the carousel TRACK, then treat its children as the items. Detect by STRUCTURE,
      // not scrollWidth: descend the subtree to the shallowest node whose children form a
      // horizontal ROW of >=2 SIMILAR-sized items (the slides). A plain "descend to first
      // multi-child node" stops too early when the container mixes a heading with the
      // carousel (container > [title, swiper] reads as a vertical stack) or nests the
      // wrapper under a single-child level (container > nudge-swiper > swiper-wrapper >
      // slides — the 1-child level breaks a >=2-kids descent). BFS through WIDE children
      // (the carousel spine, not sidebars) reaches the real slide row past both. The row
      // test (side-by-side + similar widths) is the carousel signature and guards against
      // generic clipped / 2-column content.
      const bigKids = (e) => [...e.children].filter((ch) => { const r = ch.getBoundingClientRect(); return r.width >= 40 && r.height >= 40; });
      const isRow = (its) => {
        if (its.length < 2) return false;
        const rs = its.map((i) => i.getBoundingClientRect());
        if (new Set(rs.map((r) => Math.round(r.left / 8))).size < 2) return false; // stacked, not a strip
        const ws = rs.map((r) => r.width);
        return Math.max(...ws) <= Math.min(...ws) * 1.8; // similar widths → a card row
      };
      let track = null;
      const queue = [[el, 0]];
      while (queue.length) {
        const [n, d] = queue.shift();
        if (d > 10) continue;
        if (isRow(bigKids(n))) { track = n; break; }
        for (const ch of bigKids(n)) { if (ch.getBoundingClientRect().width >= n.clientWidth * 0.5) queue.push([ch, d + 1]); }
      }
      if (!track) continue;
      for (const ch of bigKids(track)) scrollItems.add(ch);
      scrollContainers.add(el);
    }
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
    // Individual carousel/strip item cards first (bypass outermost-only).
    scrollItems.forEach(pushClk);
    // Then other clickables. NOT outermost-only (that rule DROPPED every genuinely
    // distinct inner clickable whenever ANY ancestor matched CLICK_SEL — e.g. IDFC's
    // "The Concept" anchor nested in a delegated-listener hero banner never got its
    // own box, only the whole banner did, even though clicking anywhere else in the
    // banner does nothing (#61/#62). At scale this is the SAME reason many sites
    // render a box as large as the WHOLE PAGE: a framework's event-delegation root
    // (React/Vue/etc attach ONE click listener at the app root for performance) gets
    // tagged [data-ppd-click] by the click-listener instrument (capture.js — any
    // Element registering a click/pointerdown/mousedown listener, no exclusion for a
    // root container), and under outermost-only that root swallowed every real
    // link/button on the page into one giant box. Instead: collect every CLICK_SEL
    // match, then drop a candidate ONLY if it CONTAINS another candidate (or a
    // scroll-item card) — a user perceives the SPECIFIC inner element (a link, button,
    // ARIA role) as clickable, never the whole wrapping region; a delegated listener
    // on the wrapper (data-ppd-click is best-effort — can't tell WHICH descendants it
    // actually reacts to) still fires via bubbling when the precise inner element is
    // clicked, so no behaviour is lost by drawing only the inner box.
    const clickCands = [...document.querySelectorAll(CLICK_SEL)];
    const wrapsCandidate = (el) => {
      for (const other of clickCands) { if (other !== el && el.contains(other)) return true; }
      for (const it of scrollItems) { if (it !== el && el.contains(it)) return true; }
      return false;
    };
    clickCands.forEach((el) => {
      if (scrollContainers.has(el)) return; // scroll container → its items are the clickables
      if (wrapsCandidate(el)) return;
      pushClk(el);
    });

    // --- HIDDEN SLIDER CONTENT (#63): off-screen items of detected horizontal
    // sliders/carousels. The node/media/clickable walkers above all SKIP clipped/
    // off-screen elements (isHiddenByClipOrOffscreen), so a carousel's non-visible
    // slides and a slider's off-screen cards (e.g. Latest Blog Posts) never enter
    // the model — and their text then leaks into plain content-missing elsewhere.
    // Capture them as a SEPARATE layer at their NATURAL-FLOW positions (where they
    // render unhidden — slides flow to the right of the visible one): temporarily
    // neutralise overflow + transform on the slider containers/tracks so every
    // slide lays out in its real row, measure item boxes + text runs there, then
    // RESTORE (the base screenshot runs after this and must see the pristine page).
    const hiddenNodes = [];
    const hiddenItems = [];
    const containerOf = (it) => { for (const sc of scrollContainers) { if (sc.contains(it)) return sc; } return null; };
    const allItems = [...scrollItems].filter((it) => !anyHiddenAncestor(it) && !isInClosedDetails(it));
    const offItems = allItems.filter((it) => isHiddenByClipOrOffscreen(it));
    if (offItems.length) {
      // Capture the FULL slide set of every slider that has ANY off-screen item —
      // not just the off-screen items. WHY: which slide a carousel shows is transient
      // (autoplay / random start / different slide index per side), so capturing only
      // the *hidden* slides makes the captured set nondeterministic and asymmetric
      // across source/target (the momentarily-visible slide is the one that differs),
      // which reads in the review as "slide only on source / only on target" even
      // though it's present on both. Capturing every slide of the slider makes the set
      // deterministic and identical across sides → cross-side pairing is 1:1. The
      // currently-visible slide is re-based onto its own on-page spot (below), so its
      // ghost overlaps the real slide in the normal view; sliders with nothing hidden
      // are left alone (no ghosts fabricated). #63.
      const hiddenContainers = new Set();
      for (const it of offItems) { const c = containerOf(it); if (c) hiddenContainers.add(c); }
      const capItems = allItems.filter((it) => { const c = containerOf(it); return c && hiddenContainers.has(c); });
      // Re-base each slider's de-clipped flow row onto its VISIBLE slide, so earlier
      // slides land to the LEFT of the on-screen one and later slides to the RIGHT
      // (rather than all piling from x=0 and overlapping the visible slide). Record,
      // per slider, a currently-visible reference item's ORIGINAL on-page position
      // BEFORE de-clip; after de-clip, shift = original − flow for that ref.
      const refOrig = new Map(); // container -> { el, x, y }
      for (const it of allItems) {
        if (isHiddenByClipOrOffscreen(it)) continue;
        const c = containerOf(it);
        if (!c || refOrig.has(c)) continue;
        const r = it.getBoundingClientRect();
        refOrig.set(c, { el: it, x: r.left + window.scrollX, y: r.top + window.scrollY });
      }
      // Fallback reference for sliders with NO currently-visible item (e.g. a fade/
      // cross-fade carousel where all slides stack): the CONTAINER's own original
      // position. Its vertical shift under de-clip corrects the ~53px drift that
      // otherwise hit these ref-less sliders (which got shift={0,0} → raw de-clipped
      // y, measured in the vertically-shifted de-clipped layout). #63.
      const contOrig = new Map(); // container -> { el, x, y }
      for (const it of offItems) {
        const c = containerOf(it);
        if (!c || contOrig.has(c)) continue;
        const r = c.getBoundingClientRect();
        contOrig.set(c, { el: c, x: r.left + window.scrollX, y: r.top + window.scrollY });
      }
      const savedStyle = [];
      const touched = new Set();
      for (const it of offItems) {
        for (let p = it.parentElement; p; p = p.parentElement) {
          if (touched.has(p)) continue;
          const cs = window.getComputedStyle(p);
          const clipsOrScrolls = /(auto|scroll|hidden|clip)/.test(cs.overflowX + ' ' + cs.overflowY);
          if (clipsOrScrolls || cs.transform !== 'none') {
            touched.add(p);
            savedStyle.push([p, p.getAttribute('style')]);
            p.style.setProperty('overflow', 'visible', 'important');
            p.style.setProperty('transform', 'none', 'important');
          }
        }
      }
      void document.documentElement.offsetHeight; // force reflow into the natural row
      // Per-slider shift = (ref's ORIGINAL on-page pos) − (ref's FLOW pos). Prefer
      // a visible ITEM (gives left/right flow around it); else fall back to the
      // CONTAINER (at least corrects the vertical drift).
      const shiftOf = new Map();
      for (const [c, ref] of refOrig) {
        const fr = ref.el.getBoundingClientRect();
        shiftOf.set(c, { dx: ref.x - (fr.left + window.scrollX), dy: ref.y - (fr.top + window.scrollY) });
      }
      for (const [c, co] of contOrig) {
        if (shiftOf.has(c)) continue;
        const fr = co.el.getBoundingClientRect();
        shiftOf.set(c, { dx: co.x - (fr.left + window.scrollX), dy: co.y - (fr.top + window.scrollY) });
      }
      capItems.forEach((it, idx) => {
        const ir = it.getBoundingClientRect();
        if (ir.width < 6 || ir.height < 6) return;
        const sh = (containerOf(it) && shiftOf.get(containerOf(it))) || { dx: 0, dy: 0 };
        const clickable = it.matches(CLICK_SEL) || !!it.querySelector(CLICK_SEL);
        const visibleNow = !isHiddenByClipOrOffscreen(it);
        // Tag so a Playwright pass (capture.js) can re-locate + screenshot this item
        // for its faded ghost background (#63). Removed after that pass.
        try { it.setAttribute('data-ppd-hidden', String(idx)); } catch { /* ignore */ }
        hiddenItems.push({
          idx,
          x: Math.round(ir.left + window.scrollX + sh.dx),
          y: Math.round(ir.top + window.scrollY + sh.dy),
          w: Math.round(ir.width),
          h: Math.round(ir.height),
          clickable,
          visibleNow, // this slide is the one currently on-screen (its ghost overlaps the real view)
        });
        // Text runs within this off-screen item, at their (re-based) natural
        // positions — same shape as nodes[] so the review renders them identically.
        const tw = document.createTreeWalker(it, NodeFilter.SHOW_TEXT);
        for (let node = tw.nextNode(); node; node = tw.nextNode()) {
          const raw = node.nodeValue;
          if (!raw || !raw.trim()) continue;
          const el = node.parentElement;
          if (!el || el.closest('script,style,template,noscript')) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          const st = window.getComputedStyle(el);
          hiddenNodes.push({
            kind: 'text',
            hidden: true,
            itemIdx: idx,
            visibleNow,
            clickable,
            text: raw.replace(/\s+/g, ' ').trim(),
            x: Math.round(rect.left + window.scrollX + sh.dx),
            y: Math.round(rect.top + window.scrollY + sh.dy),
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
            textTransform: st.textTransform,
            fontVariant: st.fontVariantCaps || st.fontVariant,
          });
        }
      });
      for (const [p, s] of savedStyle) { if (s === null) p.removeAttribute('style'); else p.setAttribute('style', s); }
      void document.documentElement.offsetHeight; // restore the pristine layout
    }

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
      hiddenNodes,
      hiddenItems,
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
function renderPearNodes(clm, opts = {}) {
  // Layer order matters: paint images/backgrounds first so text (added last)
  // always sits on top and stays readable — the target's full-bleed hero image
  // otherwise buries the copy under it.
  // `opts.ghost`: this is a hidden-slider ghost layer painted OVER the slide's own
  // faded screenshot, so the light-text readability chip is both unnecessary and
  // harmful — it hides the baked text underneath, making it impossible to see
  // whether the pear text registers with the screenshot. Drop it for ghosts.
  const imgParts = [];
  const textParts = [];
  for (const n of clm.nodes) {
    const posFlag = n.position === 'fixed' || n.position === 'sticky';
    const base = `position:absolute;left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;`;
    if (n.kind === 'text') {
      // Near-white / very light text would vanish on the white canvas; drop a
      // dark chip behind it so it reads while keeping its true colour.
      const lum = luminance(n.color);
      const lightText = !opts.ghost && lum != null && lum > 0.7;
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
