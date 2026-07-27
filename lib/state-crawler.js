/**
 * state-crawler — a bounded, one-hop interaction crawl for content that only
 * appears after a click (lazy/AJAX panels, JS-injected modals, carousel slides
 * not pre-rendered). From the stabilized base state we click each NON-navigating
 * trigger once, harvest newly-visible text, and (optionally) snapshot the
 * resulting state as a pear + screenshot, attributing it to that trigger.
 *
 * Revert between clicks is done IN PLACE via a MutationObserver: we record the
 * DOM changes a click makes and reverse them (remove added nodes, re-insert
 * removed nodes, restore changed attributes/text). Because this operates on the
 * SAME node objects, every original node keeps its event listeners, so the next
 * trigger still works — unlike replacing innerHTML. This runs on ONE page with
 * no reloads and no parallel tabs. A reload is the fallback only when a click
 * navigates away or undo leaves residue (a rare irreversible interaction).
 *
 * Requires the page to be stabilized/frozen first (captureFullPageBuffer does
 * this before onPageReady): with animations frozen and intervals cleared, an
 * auto-advancing carousel can't drift the DOM between record and undo.
 */

const crypto = require('crypto');
const {
  captureFullPageBuffer,
  stabilizePageForCapture,
  dismissModals,
  hideLowerPinnedOverlays,
  DEFAULT_MODAL_SELECTORS,
} = require('./capture');
const { extractCanonicalLayout } = require('./canonical-layout');

// Triggers we click — anything a user could interact with to reveal or change
// content. ANCHORS (a[href]) are included: the crawl must be framework-agnostic
// (judge from the user's POV, not EDS's), and anchor-driven sites put their cards
// / tabs / section nav on <a>, not buttons — excluding them under-explored those
// sites (EDS-shaped bias). Cross-page navigation is neutralised by
// installNavBlocker (the anchor's JS handler still runs); same-page #hash anchors
// are allowed to fire — a hash-routing SPA reveals content through them (DOM
// mutation, reversible by mutation-undo), and a plain scroll-to-anchor simply
// harvests nothing new = a no-op. (The old exclusion cited the position-delta
// signal, retired in P5 — that reason no longer applies.)
const TRIGGER_SEL = [
  'button',
  'summary',
  'a[href]',
  '[role=button]',
  '[role=tab]',
  '[aria-expanded]',
  '[aria-controls]',
  '[data-ppd-click]',
].join(',');
// Carousel / strip items (the former `.swiper-*` class hack) are NOT selected by
// class name — that only worked for English-named Swiper markup and made source
// (Swiper) and target (EDS) detect differently. Instead tagTriggers adds them
// FRAMEWORK-BLIND: the items of any horizontal SCROLL CONTAINER — an element that
// CLIPS its overflow (overflow-x auto/scroll/hidden) whose content is wider than its
// box (scrollWidth > clientWidth), i.e. content hidden off to the side. See tagTriggers.

// (Legacy param, kept for the tagTriggers signature; no longer library-specific.)
const ITEM_SEL = '[role=tab]';

/** Collect currently-visible, on-page text lines. */
function harvestVisibleText(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') < 0.05) return false;
        // Closed <details> (EDS accordion) paints only its <summary> — treat the
        // rest as hidden, matching the CLM. Otherwise the base "seen" set holds
        // the collapsed content and clicking to open it reveals "nothing new",
        // so no state is captured (the source/target accordion asymmetry).
        if (p.tagName === 'DETAILS' && !p.hasAttribute('open')) {
          const summary = p.querySelector(':scope > summary');
          if (!summary || !summary.contains(el)) return false;
        }
      }
      return true;
    };
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) continue;
      const el = n.parentElement;
      if (!el || el.closest('script,style,template,noscript')) continue;
      if (!vis(el)) continue;
      out.push(t);
    }
    return out;
  });
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Neutralize cross-page navigation (links/forms/beforeunload) so a click that
 * would leave the page instead just fires its JS handlers (tabs/modals/etc.). */
function installNavBlocker(page) {
  return page.evaluate(() => {
    if (window.__ppdNavBlock) return;
    window.__ppdNavBlock = 1;
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a) {
        const h = (a.getAttribute('href') || '').trim();
        // Block only CROSS-PAGE navigation (it would leave the page and lose the
        // crawl). ALLOW same-page #hash anchors and javascript: hrefs to fire:
        // a hash-routing SPA reveals content through them (DOM mutation, reversible
        // by mutation-undo), and a plain scroll-to-anchor just harvests nothing new
        // (a no-op). The explorer resets scroll per click, so the scroll side-effect
        // doesn't leak. Any JS click handler on the element runs regardless.
        const hl = h.toLowerCase();
        if (h && !hl.startsWith('javascript:') && !h.startsWith('#')) e.preventDefault();
      }
    }, true);
    document.addEventListener('submit', (e) => e.preventDefault(), true);
    window.onbeforeunload = null;
  });
}

/**
 * Install the in-page mutation record/undo helpers. __ppdMutStart begins
 * recording DOM changes; __ppdMutUndo reverses them (in reverse order) and
 * returns the number of mutations undone. Reversing the recorded mutations —
 * rather than replacing the DOM — keeps every original node object (and its
 * event listeners) intact, so subsequent clicks still fire.
 */
function installMutationUndo(page) {
  return page.evaluate(() => {
    window.__ppdMutStart = () => {
      window.__ppdRec = [];
      const ob = new MutationObserver((ms) => window.__ppdRec.push(...ms));
      ob.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true,
      });
      window.__ppdOb = ob;
    };
    window.__ppdMutUndo = () => {
      const ob = window.__ppdOb;
      if (!ob) return 0;
      window.__ppdRec.push(...ob.takeRecords()); // flush not-yet-delivered records
      ob.disconnect();
      const all = window.__ppdRec;
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i];
        try {
          if (m.type === 'childList') {
            for (const nd of m.addedNodes) {
              if (nd.parentNode) nd.parentNode.removeChild(nd);
            }
            const rm = Array.from(m.removedNodes);
            for (let j = rm.length - 1; j >= 0; j--) {
              const nd = rm[j];
              if (m.nextSibling && m.nextSibling.parentNode === m.target) m.target.insertBefore(nd, m.nextSibling);
              else if (m.target) m.target.appendChild(nd);
            }
          } else if (m.type === 'attributes') {
            if (m.oldValue === null) m.target.removeAttribute(m.attributeName);
            else m.target.setAttribute(m.attributeName, m.oldValue);
          } else if (m.type === 'characterData') {
            m.target.data = m.oldValue;
          }
        } catch {
          /* best-effort per-mutation */
        }
      }
      const n = all.length;
      window.__ppdRec = null;
      window.__ppdOb = null;
      return n;
    };
  });
}

/** Tag the outermost, currently-visible triggers with a stable index (so the
 * click budget is spent on real triggers, not hidden mega-menu items); returns
 * the count. */
function tagTriggers(page, sel, itemSel, debug) {
  return page.evaluate(
    ({ SEL, ITEM, DBG }) => {
      const vis = (el) => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') < 0.05) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 6 && r.height >= 6;
      };
      // Debug: record every SEL candidate and why it was tagged or skipped, so a
      // trigger that "won't click" (e.g. shadowed by a delegated-listener wrapper)
      // is visible. Only built when DBG; stashed on window for the caller to read.
      const dbg = DBG ? [] : null;
      const meta = (el) => ({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 45),
        href: el.getAttribute ? el.getAttribute('href') : null,
        ppd: !!(el.hasAttribute && el.hasAttribute('data-ppd-click')),
        label: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      });
      // Pass 1 — collect visible, in-page candidates (record the skips as before).
      const cands = [];
      const candSet = new Set();
      const addCand = (el, srcTag) => {
        if (candSet.has(el)) return;
        const rec = dbg ? meta(el) : null;
        if (rec && srcTag) rec.src = srcTag;
        // Skip navigating anchors — clicking them leaves the page, they're not
        // in-page reveals (and the nav-blocker would just no-op the click).
        const a = el.closest('a[href]');
        if (a) {
          const h = (a.getAttribute('href') || '').trim().toLowerCase();
          if (h && !h.startsWith('#') && !h.startsWith('javascript:')) {
            if (rec) { rec.skip = 'cross-page-anchor(' + h.slice(0, 24) + ')'; dbg.push(rec); }
            return;
          }
        }
        if (!vis(el)) {
          if (rec) { rec.skip = 'not-visible'; dbg.push(rec); }
          return;
        }
        candSet.add(el);
        cands.push({ el, rec });
      };
      document.querySelectorAll(SEL).forEach((el) => addCand(el));
      // FRAMEWORK-BLIND carousel/strip items (replaces the `.swiper-*` selectors): the
      // items of any HORIZONTAL SCROLL CONTAINER — an element that CLIPS its overflow
      // (overflow-x auto/scroll/hidden) whose content is wider than its box
      // (scrollWidth > clientWidth), i.e. there's content hidden off to the side. The
      // items are the children of the inner "track": descend a single-child chain (a
      // Swiper is .swiper > .swiper-wrapper > slides, but we follow STRUCTURE, not
      // class), then take that track's sizable children. Any library, any language;
      // makes source (which clips into carousels) and target (which usually doesn't)
      // detect by ONE rule. Horizontal only for now — vertical scroll zones are a
      // separate matter (their items would overlap content below).
      for (const el of document.querySelectorAll('*')) {
        if (el === document.documentElement || el === document.body) continue;
        const cs = getComputedStyle(el);
        if (!/(auto|scroll|hidden)/.test(cs.overflowX)) continue;
        if (el.clientWidth < 40 || el.scrollWidth <= el.clientWidth + 2) continue;
        // Find the inner TRACK: descend into any child whose CONTENT overflows the
        // container (scrollWidth > container clientWidth — a Swiper .swiper-wrapper, a
        // flex row); repeat. Use scrollWidth, not rect width: a nested track is clipped
        // to the container width by rect but its content width stays wide. If none
        // overflows, the items are the direct children.
        let track = el;
        for (let d = 0; d < 8; d += 1) {
          let next = null;
          for (const ch of track.children) { if (ch.scrollWidth > el.clientWidth + 2) { next = ch; break; } }
          if (!next) break;
          track = next;
        }
        for (const ch of track.children) {
          const r = ch.getBoundingClientRect();
          if (r.width >= 40 && r.height >= 40) addCand(ch, 'scroll-item');
        }
      }
      // Pass 2 — shadow WRAPPERS that span their own children (#62). The old
      // "outermost-only" rule (skip anything nested in another trigger) was too
      // blunt — it hid genuine inner triggers (nav items, cards in a delegated-
      // listener container), so we un-shadowed. But that over-corrected: a carousel
      // strip / nav bar / tab list gets tagged AS WELL AS each child, and its box
      // spans all of them — overlapping, misleading solid boxes in the review (the
      // "Higher tier"/"Joining fee" strip). A user never clicks the strip; they
      // click a card. So drop a candidate that CONTAINS >=2 other candidates: the
      // user clicks the specific child, and a trusted centre-click on that child
      // still bubbles to the wrapper's own handler, so no behaviour is lost. A
      // single wrapped trigger (e.g. "The Concept" banner -> one inner anchor) has
      // <2 and is KEPT, so nested single reveals stay covered.
      const wrapsChild = (o) => {
        let n = 0;
        for (const p of cands) {
          if (p.el !== o.el && o.el.contains(p.el)) { n += 1; if (n >= 2) return true; }
        }
        return false;
      };
      let i = 0;
      cands.forEach((o) => {
        if (wrapsChild(o)) {
          if (o.rec) { o.rec.skip = 'wrapper-spans-children'; dbg.push(o.rec); }
          return;
        }
        o.el.setAttribute('data-ppd-idx', String(i));
        if (o.rec) { o.rec.tagged = i; dbg.push(o.rec); }
        i += 1;
      });
      if (dbg) window.__ppdTagDbg = dbg;
      return i;
    },
    { SEL: sel, ITEM: itemSel, DBG: !!debug }
  );
}

/**
 * Run the one-hop crawl on a live, stabilized page (single page, in-place
 * mutation-undo between clicks).
 * @returns {{ revealed, states, triggersClicked, triggersTotal, navigations, reloads }}
 */
async function crawlStates(page, opts = {}) {
  const maxTriggers = opts.maxTriggers ?? 80;
  const settleMs = opts.settleMs ?? 350;
  const baseUrl = page.url();
  const captureStates = !!opts.captureStates;
  const maxStates = opts.maxStates ?? 60;

  await installNavBlocker(page);
  await installMutationUndo(page);
  let count = await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
  const baseHarvest = (await harvestVisibleText(page)).map(norm);
  const seen = new Set(baseHarvest); // grows: a revealed line is attributed once
  const baseSet = new Set(baseHarvest); // pristine base (never grows) — residue check
  const revealed = [];
  const states = [];
  const stateSigs = new Set();
  let clicked = 0;
  let navigations = 0;
  let reloads = 0;

  // Fallback ONLY when in-place undo can't restore base: a real navigation, or
  // undo leaving residue (a rare irreversible interaction). Warm reload (cached
  // assets, domcontentloaded + fast scroll) + re-stabilize + re-tag.
  const capOpts = opts.captureOptions || {};
  const reloadToBase = async () => {
    reloads += 1;
    try {
      await page.goto(baseUrl, { waitUntil: capOpts.gotoWaitUntil || 'domcontentloaded' });
      try {
        await page.evaluate(async () => {
          const step = Math.max(600, Math.floor(window.innerHeight * 0.9));
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 25));
          }
          window.scrollTo(0, 0);
        });
      } catch {
        /* ignore */
      }
      try {
        await stabilizePageForCapture(page, {
          freezeAnimations: capOpts.freezeAnimations,
          removeModalSelectors: capOpts.removeModalSelectors,
          ocrContrast: capOpts.ocrContrast,
        });
      } catch {
        /* ignore */
      }
      try {
        await page.keyboard.press('Escape');
        await dismissModals(page, capOpts.removeModalSelectors || DEFAULT_MODAL_SELECTORS);
      } catch {
        /* ignore */
      }
      try {
        await hideLowerPinnedOverlays(page);
      } catch {
        /* ignore */
      }
      await page.waitForTimeout(capOpts.stabilizeSettleMs ?? 300);
      await installNavBlocker(page);
      await installMutationUndo(page);
      // Never let a fallback reload that re-tags LOW (under-decorated) shrink the
      // loop bound and cut coverage — keep the max seen.
      count = Math.max(count, await tagTriggers(page, TRIGGER_SEL, ITEM_SEL));
    } catch {
      /* best-effort reset */
    }
  };

  for (let i = 0; i < Math.min(count, maxTriggers); i++) {
    const h = await page.$(`[data-ppd-idx="${i}"]`);
    if (!h) continue;
    let info = null;
    try {
      info = await h.evaluate((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (s.display === 'none' || s.visibility === 'hidden' || r.width < 6 || r.height < 6) return null;
        return {
          label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
    } catch {
      continue;
    }
    if (!info) continue;
    clicked += 1;

    // Record DOM changes around the click so we can revert IN PLACE afterwards.
    await page.evaluate(() => window.__ppdMutStart());
    try {
      // Click WITHOUT scrolling (el.click(), no Playwright scrollIntoView): a
      // scroll can trigger lazy/below-fold content that isn't a reversible
      // click-effect. Off-viewport elements still receive the dispatched click.
      await h.evaluate((el) => el.click());
    } catch {
      await page.evaluate(() => window.__ppdMutUndo());
      continue;
    }
    // Keep the observer live through the settle so async (fetched) modal content
    // is recorded too, and thus reversible.
    await page.waitForTimeout(settleMs);

    if (page.url() !== baseUrl) {
      navigations += 1;
      await reloadToBase(); // navigated away despite the blocker → hard reset
      continue;
    }

    const now = await harvestVisibleText(page);
    const clickNew = [];
    for (const t of now) {
      const k = norm(t);
      if (k && !seen.has(k)) {
        seen.add(k);
        clickNew.push(t);
        revealed.push({ text: t, triggerLabel: info.label, triggerX: info.x, triggerY: info.y, triggerW: info.w, triggerH: info.h });
      }
    }

    // Per-state capture while the reveal is showing: pear (CLM) + full-page
    // screenshot, keyed to the trigger, deduped by a signature of the full
    // visible-text set, bounded by maxStates. A click that reveals nothing
    // captures no state.
    if (captureStates && clickNew.length && states.length < maxStates) {
      const sig = crypto.createHash('sha1').update(now.map(norm).sort().join('\n')).digest('hex');
      if (!stateSigs.has(sig)) {
        stateSigs.add(sig);
        let clm = null;
        let shot = null;
        try {
          clm = await extractCanonicalLayout(page);
        } catch {
          /* ignore — pear is best-effort */
        }
        try {
          shot = await page.screenshot({ fullPage: true, type: 'png' });
        } catch {
          /* ignore — screenshot is best-effort */
        }
        states.push({
          signature: sig,
          triggerLabel: info.label,
          triggerX: info.x,
          triggerY: info.y,
          triggerW: info.w,
          triggerH: info.h,
          revealedCount: clickNew.length,
          revealed: clickNew.slice(0, 200),
          clm,
          shot,
        });
      }
    }

    // Revert this click's DOM changes in place (reverse the recorded mutations).
    const mutCount = await page.evaluate(() => window.__ppdMutUndo());
    // Safety net: if the click mutated the DOM and undo left residue (rare
    // irreversible interaction), reload to a clean base so it can't bleed into
    // the next trigger's captured state.
    if (mutCount > 0) {
      try {
        const after = await harvestVisibleText(page);
        const residue = after.some((t) => {
          const k = norm(t);
          return k && !baseSet.has(k);
        });
        if (residue) await reloadToBase();
      } catch {
        /* ignore */
      }
    }
  }
  return { revealed, states, triggersClicked: clicked, triggersTotal: count, navigations, reloads };
}

/** Launch + stabilize a page (reusing the capture pipeline) and crawl it. */
async function crawlUrl(url, opts = {}) {
  const { onPageReadyResult } = await captureFullPageBuffer(url, {
    ...(opts.captureOptions || {}),
    collectCanonicalLayout: true, // installs the click-listener instrument → better triggers
    onPageReady: (page) => crawlStates(page, opts),
  });
  return onPageReadyResult || { revealed: [], states: [], triggersClicked: 0, triggersTotal: 0, navigations: 0, reloads: 0 };
}

module.exports = {
  crawlStates,
  crawlUrl,
  harvestVisibleText,
  // Reused by the recursive explorer (lib/recursive-explorer.js) to avoid
  // duplicating the known-good trigger/nav machinery.
  installNavBlocker,
  tagTriggers,
  norm,
  TRIGGER_SEL,
  ITEM_SEL,
};
