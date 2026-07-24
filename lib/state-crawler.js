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
  '.swiper-slide', // carousel cards often open a modal via delegation on the swiper
  '.swiper-button-next',
  '.swiper-pagination-bullet',
].join(',');

// Item-type triggers that are individually clickable even when nested inside
// another trigger (e.g. a swiper-slide inside a swiper container that itself
// carries a delegated click listener). The outermost-only rule is bypassed for
// these, otherwise the container would shadow every card.
const ITEM_SEL = '.swiper-slide,[role=tab],.swiper-pagination-bullet';

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
function tagTriggers(page, sel, itemSel) {
  return page.evaluate(
    ({ SEL, ITEM }) => {
      const vis = (el) => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') < 0.05) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 6 && r.height >= 6;
      };
      let i = 0;
      document.querySelectorAll(SEL).forEach((el) => {
        // Skip navigating anchors — clicking them leaves the page, they're not
        // in-page reveals (and the nav-blocker would just no-op the click).
        const a = el.closest('a[href]');
        if (a) {
          const h = (a.getAttribute('href') || '').trim().toLowerCase();
          if (h && !h.startsWith('#') && !h.startsWith('javascript:')) return;
        }
        // Outermost-only, EXCEPT item-type triggers (slides/tabs), which are
        // individually clickable inside a delegated container.
        if (!el.matches(ITEM) && el.parentElement && el.parentElement.closest(SEL)) return;
        if (!vis(el)) return;
        el.setAttribute('data-ppd-idx', String(i));
        i += 1;
      });
      return i;
    },
    { SEL: sel, ITEM: itemSel }
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
