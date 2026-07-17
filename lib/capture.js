const { chromium } = require('playwright');
const { dismissOverlaysOnPage } = require('./overlay-dismiss');
const { extractVisibleText, extractPageDimensions } = require('./visible-text');
const { extractExpandedVisibleText, isTextExpansionEnabled } = require('./text-expansion');
const { resolveProfile } = require('./profiles');
const { extractEdsBlocks } = require('./eds-structure');
const { extractTextFingerprint } = require('./text-geometry');
const { extractCanonicalLayout } = require('./canonical-layout');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

/** `networkidle` often never fires (analytics, long polling). Default `load` + scroll-for-lazy-load avoids ~60s stalls. */
const DEFAULT_GOTO_WAIT_UNTIL = 'load';

/**
 * When primary waitUntil is networkidle, cap first attempt so we fall back to domcontentloaded quickly.
 */
function primaryNavigationTimeout(waitUntil, navigationTimeoutMs, explicitMs) {
  if (explicitMs != null && explicitMs > 0) return explicitMs;
  if (waitUntil === 'networkidle') {
    const cap = parseInt(process.env.PPD_GOTO_NETWORKIDLE_TIMEOUT_MS || '12000', 10);
    return Math.min(navigationTimeoutMs, cap);
  }
  return navigationTimeoutMs;
}

const ANTI_BOT_CONFIG = {
  minDelayBetweenPages: 1000,
  maxDelayBetweenPages: 2500,
  maxRetries: 5,
  retryDelayBase: 5000,
  retryDelayMax: 25000,
};

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay(minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function isCloudflareBlocked(page) {
  try {
    return await page.evaluate(() => {
      const cfIndicators = [
        '#cf-wrapper',
        '#cf-error-details',
        '.cf-error-overview',
        '.cf-cookie-error',
        '#challenge-running',
        '#challenge-stage',
      ];
      for (const selector of cfIndicators) {
        if (document.querySelector(selector)) return true;
      }
      const title = document.title.toLowerCase();
      if (
        title.includes('just a moment') ||
        title.includes('cloudflare') ||
        title.includes('attention required') ||
        title.includes('access denied')
      ) {
        return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function applyAntiBotEvasion(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      ],
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  });
}

async function scrollPageForLazyLoad(page) {
  await page.evaluate(async () => {
    const waitForImages = async () => {
      const images = document.querySelectorAll(
        'img[loading="lazy"], img[data-src], img:not([src=""])'
      );
      const visibleImages = Array.from(images).filter((img) => {
        const rect = img.getBoundingClientRect();
        return rect.top < window.innerHeight + 500 && rect.bottom > -500;
      });
      await Promise.race([
        Promise.all(
          visibleImages.map((img) =>
            img.complete
              ? Promise.resolve()
              : new Promise((resolve) => {
                  img.onload = resolve;
                  img.onerror = resolve;
                  setTimeout(resolve, 2000);
                })
          )
        ),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    };

    let lastScrollHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 3;

    while (scrollAttempts < maxScrollAttempts) {
      const scrollHeight = document.body.scrollHeight;
      const scrollStep = 400;

      for (let y = 0; y < scrollHeight; y += scrollStep) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }

      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 500));
      await waitForImages();

      const newScrollHeight = document.body.scrollHeight;
      if (newScrollHeight === lastScrollHeight) break;
      lastScrollHeight = newScrollHeight;
      scrollAttempts++;
    }

    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 500));
  });

  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    /* ignore */
  }
}

/**
 * Right before the screenshot: freeze animations/transitions (so auto-advancing
 * carousels and CSS animations don't capture a random frame) and remove overlay
 * modals that still cover the page. This is a deterministic, DOM-level cleanup —
 * an interim measure until recipe/scout-driven handling (removes the EDS
 * `.modal.block` and common backdrops; the recipe's `ignore` list will extend
 * this later). Returns counts for logging.
 */
const DEFAULT_MODAL_SELECTORS = [
  '.modal.block', // EDS modal block wrapper
  'dialog[open]', // native <dialog> opened via showModal() (EDS modal.js) — no aria-modal attr
  'dialog.modal',
  '[aria-modal="true"]',
  '.modal-backdrop',
  '.overlay-backdrop',
];

/**
 * Remove modals/backdrops currently in the DOM (known selectors + a generic
 * full-viewport translucent-backdrop heuristic) and unlock body scroll. Used
 * both inside stabilize and as a final gate right before the screenshot, since
 * some dialogs (intermittent promo/consent popups) open asynchronously after
 * the initial stabilize pass.
 */
async function dismissModals(page, selectors) {
  return page.evaluate((sels) => {
    let removed = 0;
    for (const sel of sels) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          el.remove();
          removed += 1;
        });
      } catch {
        /* invalid selector — skip */
      }
    }
    // Generic: a fixed element covering ~the whole viewport with a translucent
    // background is almost certainly a modal backdrop — drop it (and its dialog).
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    document.querySelectorAll('body *').forEach((el) => {
      const s = window.getComputedStyle(el);
      if (s.position !== 'fixed' || s.display === 'none' || s.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.9 || r.height < vh * 0.9 || r.top > 5 || r.left > 5) return;
      const m = (s.backgroundColor || '').match(/rgba?\(([^)]+)\)/);
      const parts = m ? m[1].split(',') : [];
      const alpha = parts.length > 3 ? parseFloat(parts[3]) : m ? 1 : 0;
      if (alpha > 0.05 && alpha < 1) {
        el.remove();
        removed += 1;
      }
    });
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    return removed;
  }, selectors);
}

async function stabilizePageForCapture(page, opts = {}) {
  const freezeAnimations = opts.freezeAnimations !== false;
  const ocrContrast = opts.ocrContrast === true;
  const removeModalSelectors = opts.removeModalSelectors || DEFAULT_MODAL_SELECTORS;
  return page.evaluate(
    ({ freeze, selectors, ocrContrast }) => {
      let modalsRemoved = 0;
      for (const sel of selectors) {
        try {
          document.querySelectorAll(sel).forEach((el) => {
            el.remove();
            modalsRemoved += 1;
          });
        } catch {
          /* invalid selector — skip */
        }
      }
      // Restore scroll/interaction in case a modal locked the body.
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      let froze = false;
      let intervalsCleared = 0;
      let mediaPaused = 0;
      if (freeze) {
        const style = document.createElement('style');
        style.setAttribute('data-ppd-freeze', '1');
        style.textContent =
          '*,*::before,*::after{animation-play-state:paused !important;' +
          'animation-delay:-0.0001s !important;animation-duration:0.0001s !important;' +
          'transition:none !important;scroll-behavior:auto !important;caret-color:transparent !important}';
        document.head.appendChild(style);
        froze = true;

        // Stop JS-driven auto-advance (carousels use setInterval) — CSS pause
        // above doesn't touch those. Safe here: lazy-load already ran and we're
        // about to screenshot. Clears all live interval ids, then pauses media.
        try {
          const maxId = setInterval(() => {}, 2147483647);
          for (let i = 0; i <= maxId; i += 1) clearInterval(i);
          intervalsCleared = maxId;
        } catch {
          /* ignore */
        }
        document.querySelectorAll('video, audio').forEach((m) => {
          try {
            m.pause();
            mediaPaused += 1;
          } catch {
            /* ignore */
          }
        });
      }
      // OCR-contrast mode: flatten the page to plain black text on white so the
      // OCR sees maximal contrast and no decorative graphics to hallucinate
      // words in. Positions are untouched — visibility:hidden (not display:none)
      // keeps every element's box, so text lands exactly where it renders now.
      let ocrFlattened = false;
      if (ocrContrast) {
        const style = document.createElement('style');
        style.setAttribute('data-ppd-ocr-contrast', '1');
        style.textContent =
          // Everything: white backgrounds, no bg images/gradients, black text,
          // no shadows, transparent borders — but layout boxes preserved.
          '*,*::before,*::after{background:#fff !important;background-image:none !important;' +
          'color:#000 !important;text-shadow:none !important;box-shadow:none !important;' +
          'border-color:transparent !important;outline-color:transparent !important;' +
          'filter:none !important;opacity:1 !important;text-decoration-color:#000 !important}' +
          // Graphics carry no OCR text and only add noise — hide them. Uses
          // visibility (not display) so their box stays and nothing reflows.
          // The global background-image:none above already clears inline/CSS
          // background images, so text inside bg-image containers is unaffected.
          'img,svg,canvas,video,picture,iframe,object,embed{visibility:hidden !important}';
        document.head.appendChild(style);
        ocrFlattened = true;
      }
      // Snap back to the absolute top. The lazy-load scroll leaves the page
      // scrolled down, and "hide-on-scroll-down" headers stay hidden — which
      // drops the header from the full-page screenshot. Many sites set
      // `html { scroll-behavior: smooth }`, so window.scrollTo(0,0) only
      // animates (doesn't take effect synchronously); force it with inline
      // scroll-behavior:auto + scrollingElement.scrollTop = 0.
      try {
        document.documentElement.style.scrollBehavior = 'auto';
        if (document.body) document.body.style.scrollBehavior = 'auto';
        const se = document.scrollingElement || document.documentElement;
        se.scrollTop = 0;
        window.scrollTo(0, 0);
      } catch {
        /* ignore */
      }
      const scrollY = window.scrollY;
      return { modalsRemoved, froze, intervalsCleared, mediaPaused, scrollY, ocrFlattened };
    },
    { freeze: freezeAnimations, selectors: removeModalSelectors, ocrContrast }
  );
}

/**
 * @param {object} options
 * @param {string} [options.captureRole] source | target — used in log event names
 * @param {(event: string, data: object) => void | Promise<void>} [options.logCaptureStep]
 */
async function captureFullPageBuffer(url, options = {}) {
  const profile = resolveProfile(options.profile);
  // Explicit options.viewport still wins (back-compat); otherwise the profile's.
  const viewport = options.viewport || profile.viewport || DEFAULT_VIEWPORT;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 60000;
  const gotoWaitUntil = options.gotoWaitUntil || DEFAULT_GOTO_WAIT_UNTIL;
  const primaryNavTimeoutMs = primaryNavigationTimeout(
    gotoWaitUntil,
    navigationTimeoutMs,
    options.gotoPrimaryTimeoutMs
  );
  const dismissOverlays = options.dismissOverlays !== false;
  const overlayLazyMs = options.overlayLazyMs ?? 4000;
  const overlayDismissMax = options.overlayDismissMax ?? 8;
  const role = options.captureRole || 'page';
  const log = options.logCaptureStep;

  async function emit(step, data = {}) {
    if (!log) return;
    await log(`capture_${role}_${step}`, { url, ...data });
  }

  let lastError = null;

  for (let attempt = 0; attempt <= ANTI_BOT_CONFIG.maxRetries; attempt++) {
    let browser = null;
    const attemptT0 = Date.now();
    try {
      let t = Date.now();
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
        ],
      });
      await emit('browser_launch', { ms: Date.now() - t, attempt, profile: profile.name });

      t = Date.now();
      const context = await browser.newContext({
        viewport,
        userAgent: profile.userAgent || getRandomUserAgent(),
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
        bypassCSP: true,
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });

      const page = await context.newPage();
      await applyAntiBotEvasion(page);
      // For the canonical layout model: tag elements that get a direct click
      // listener so the extractor can mark them clickable (read-only; delegated
      // listeners on document can't be attributed and are missed).
      if (options.collectCanonicalLayout) {
        await page.addInitScript(() => {
          const seen = new WeakSet();
          const orig = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function (type) {
            if ((type === 'click' || type === 'pointerdown' || type === 'mousedown') && this instanceof Element && !seen.has(this)) {
              seen.add(this);
              try { this.setAttribute('data-ppd-click', '1'); } catch { /* ignore */ }
            }
            return orig.apply(this, arguments);
          };
        });
      }
      await emit('context_and_page', { ms: Date.now() - t, attempt });

      /** Primary navigation; on failure we retry with domcontentloaded (full navigationTimeoutMs). */
      let gotoUsed = gotoWaitUntil;
      let primaryMs = 0;
      let fallbackMs = 0;
      let primaryError = null;
      t = Date.now();
      try {
        await page.goto(url, {
          waitUntil: gotoWaitUntil,
          timeout: primaryNavTimeoutMs,
        });
        primaryMs = Date.now() - t;
      } catch (e) {
        primaryMs = Date.now() - t;
        primaryError = e.message || String(e);
        await emit('goto_primary_failed', {
          ms: primaryMs,
          attempt,
          waitUntil: gotoWaitUntil,
          timeoutMs: primaryNavTimeoutMs,
          error: primaryError,
        });
        gotoUsed = 'domcontentloaded';
        const tFallback = Date.now();
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: navigationTimeoutMs,
        });
        fallbackMs = Date.now() - tFallback;
      }
      await emit('goto', {
        ms: primaryMs + fallbackMs,
        primaryMs,
        fallbackMs,
        attempt,
        succeededWith: gotoUsed,
        primaryAttempted: gotoWaitUntil,
      });

      t = Date.now();
      const blocked = await isCloudflareBlocked(page);
      await emit('cloudflare_check', { ms: Date.now() - t, blocked, attempt });

      if (blocked) {
        await browser.close();
        browser = null;
        await emit('attempt_aborted_cloudflare', {
          ms: Date.now() - attemptT0,
          attempt,
        });
        if (attempt < ANTI_BOT_CONFIG.maxRetries) {
          const retryDelay = Math.min(
            ANTI_BOT_CONFIG.retryDelayBase * (attempt + 1),
            ANTI_BOT_CONFIG.retryDelayMax
          );
          await new Promise((r) => setTimeout(r, retryDelay));
          continue;
        }
        throw new Error('Blocked by Cloudflare or similar challenge page');
      }

      // Storage wipe + reload so consent modals appear; wait for lazy overlays.
      t = Date.now();
      await page.evaluate(() => {
        try {
          localStorage.clear();
        } catch {
          /* ignore */
        }
        try {
          sessionStorage.clear();
        } catch {
          /* ignore */
        }
      });
      await emit('storage_clear_eval', { ms: Date.now() - t, attempt });

      t = Date.now();
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeoutMs,
      });
      await emit('reload_domcontentloaded', { ms: Date.now() - t, attempt });

      t = Date.now();
      await delay(overlayLazyMs);
      await emit('overlay_lazy_wait', {
        ms: Date.now() - t,
        configuredMs: overlayLazyMs,
        attempt,
      });

      if (dismissOverlays) {
        const overlayT0 = Date.now();
        let dismissResult = null;
        try {
          dismissResult = await dismissOverlaysOnPage(page, {
            maxOverlays: overlayDismissMax,
            logStep: log
              ? async (sub, data) =>
                  emit(`overlay_${sub}`, { attempt, ...data })
              : undefined,
          });
        } catch (e) {
          await emit('overlay_dismiss_error', {
            ms: Date.now() - overlayT0,
            error: e.message,
            attempt,
          });
        }
        if (dismissResult) {
          await emit('overlay_dismiss_summary', {
            ms: Date.now() - overlayT0,
            attempt,
            overlayCount: dismissResult.overlayCount,
            dismissed: dismissResult.dismissed,
            errorsCount: dismissResult.errors?.length ?? 0,
            timings: dismissResult.timings || null,
          });
        }
      }

      t = Date.now();
      await scrollPageForLazyLoad(page);
      await emit('scroll_lazy_load', { ms: Date.now() - t, attempt });

      // EDS (and many CMS) headers hydrate asynchronously — the <header> is
      // present but empty for a few seconds after load, and screenshotting too
      // early captures an empty header, which shifts the whole page and breaks
      // source↔target comparison. Wait for the header to actually populate.
      if (options.waitForHeader !== false) {
        const headerWaitMs = options.headerWaitMs ?? 8000;
        const hT = Date.now();
        let headerPopulated = false;
        try {
          await page.waitForFunction(
            () => {
              const h = document.querySelector('header');
              if (!h) return true; // no header element — nothing to wait for
              if ((h.innerText || '').trim().length > 10) return true;
              return !!h.querySelector('nav a, a, img, button, svg');
            },
            { timeout: headerWaitMs }
          );
          headerPopulated = true;
        } catch {
          /* proceed even if the header never populates */
        }
        await emit('wait_for_header', {
          ms: Date.now() - hT,
          attempt,
          headerPopulated,
          timeoutMs: headerWaitMs,
        });
      }

      if (options.stabilize !== false) {
        t = Date.now();
        try {
          const stab = await stabilizePageForCapture(page, {
            freezeAnimations: options.freezeAnimations,
            removeModalSelectors: options.removeModalSelectors,
            ocrContrast: options.ocrContrast,
          });
          await emit('stabilize_page', { ms: Date.now() - t, attempt, ...stab });
        } catch (e) {
          await emit('stabilize_page_error', { ms: Date.now() - t, attempt, error: e.message });
        }
        // Final modal gate: some dialogs open asynchronously after stabilize
        // (intermittent promo/consent popups), so re-run removal right before the
        // screenshot. Done before the settle delay so the page repaints clean.
        try {
          const late = await dismissModals(page, options.removeModalSelectors || DEFAULT_MODAL_SELECTORS);
          if (late) await emit('late_modal_dismissed', { count: late, attempt });
        } catch (e) {
          await emit('late_modal_error', { attempt, error: e.message });
        }
        // Let the scroll-to-top settle so a re-shown (scroll-hidden) header
        // repaints before the screenshot.
        await delay(options.stabilizeSettleMs ?? 400);
      }

      t = Date.now();
      const buffer = await page.screenshot({ fullPage: true, type: 'png' });
      await emit('screenshot_full_page', {
        ms: Date.now() - t,
        bytes: buffer.length,
        attempt,
      });

      // Canonical Layout Model — captured at the exact screenshot state, BEFORE
      // text-expansion clicks accordions / "read more" open. Otherwise the pear
      // would reflect a mutated DOM that mismatches the screenshot and expands
      // asymmetrically between source and target, inflating false diffs.
      let canonicalLayoutData = null;
      if (options.collectCanonicalLayout) {
        const clmT0 = Date.now();
        try {
          canonicalLayoutData = await extractCanonicalLayout(page);
          await emit('canonical_layout_extract', {
            ms: Date.now() - clmT0,
            nodeCount: canonicalLayoutData.nodes.length,
            attempt,
          });
        } catch (e) {
          await emit('canonical_layout_error', { ms: Date.now() - clmT0, error: e.message, attempt });
        }
      }

      let onPageReadyResult = null;
      if (typeof options.onPageReady === 'function') {
        t = Date.now();
        onPageReadyResult = await options.onPageReady(page, buffer);
        await emit('on_page_ready', { ms: Date.now() - t, attempt });
      }

      let metadata = {
        profile: profile.name,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        pageWidth: viewport.width,
        pageHeight: 0,
        title: '',
        visibleText: [],
        visibleTextCharCount: 0,
        expandedVisibleText: [],
        expandedVisibleTextCharCount: 0,
        textExpansion: null,
        edsStructure: null,
        textGeometry: null,
      };
      const collectMetadata = options.collectMetadata !== false;
      if (collectMetadata) {
        t = Date.now();
        const dims = await extractPageDimensions(page);
        const useExpansionFromHook = Boolean(onPageReadyResult?.expanded);
        const useExpansion =
          useExpansionFromHook ||
          (options.textExpansion !== false && isTextExpansionEnabled());
        let textResult;
        if (onPageReadyResult?.expanded) {
          textResult = onPageReadyResult.expanded;
        } else if (useExpansion) {
          textResult = await extractExpandedVisibleText(page);
        } else {
          textResult = await extractVisibleText(page);
        }
        metadata = {
          profile: profile.name,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          pageWidth: dims.pageWidth,
          pageHeight: dims.pageHeight,
          title: dims.title,
          visibleText: textResult.visibleText,
          visibleTextCharCount: textResult.visibleTextCharCount,
          expandedVisibleText: useExpansion
            ? textResult.expandedVisibleText
            : textResult.visibleText,
          expandedVisibleTextCharCount: useExpansion
            ? textResult.expandedVisibleTextCharCount
            : textResult.visibleTextCharCount,
          textExpansion: useExpansion
            ? textResult.expansion
            : { enabled: false, activations: 0, baselineLineCount: textResult.visibleText.length },
          edsStructure: null,
          textGeometry: null,
          canonicalLayout: null,
        };
        if (options.collectEdsStructure) {
          const edsT0 = Date.now();
          try {
            metadata.edsStructure = await extractEdsBlocks(page);
            await emit('eds_structure_extract', {
              ms: Date.now() - edsT0,
              isEds: metadata.edsStructure.isEds,
              blockCount: metadata.edsStructure.blocks.length,
              sectionCount: metadata.edsStructure.sectionCount,
              attempt,
            });
          } catch (e) {
            await emit('eds_structure_error', { ms: Date.now() - edsT0, error: e.message, attempt });
          }
        }
        if (options.collectTextGeometry) {
          const geoT0 = Date.now();
          try {
            // Extracted at the same (scroll-0, stabilized) state as the
            // screenshot, so coordinates align with the full-page image.
            metadata.textGeometry = await extractTextFingerprint(page);
            await emit('text_geometry_extract', {
              ms: Date.now() - geoT0,
              itemCount: metadata.textGeometry.length,
              attempt,
            });
          } catch (e) {
            await emit('text_geometry_error', { ms: Date.now() - geoT0, error: e.message, attempt });
          }
        }
        // Attach the pre-expansion CLM captured above (base/screenshot state).
        metadata.canonicalLayout = canonicalLayoutData;
        await emit('visible_text_extract', {
          ms: Date.now() - t,
          lineCount: metadata.visibleText.length,
          expandedLineCount: metadata.expandedVisibleText.length,
          textExpansion: metadata.textExpansion,
          pageHeight: metadata.pageHeight,
          attempt,
        });
      }

      await browser.close();
      browser = null;
      await emit('capture_ok', { ms: Date.now() - attemptT0, attempt });
      return { buffer, metadata, onPageReadyResult };
    } catch (e) {
      lastError = e;
      await emit('attempt_failed', {
        ms: Date.now() - attemptT0,
        attempt,
        error: e.message,
      });
      if (browser) {
        try {
          await browser.close();
        } catch {
          /* ignore */
        }
      }
      if (attempt < ANTI_BOT_CONFIG.maxRetries) {
        const retryDelay = Math.min(
          ANTI_BOT_CONFIG.retryDelayBase * (attempt + 1),
          ANTI_BOT_CONFIG.retryDelayMax
        );
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  }

  throw lastError || new Error('captureFullPageBuffer failed');
}

module.exports = {
  captureFullPageBuffer,
  dismissModals,
  DEFAULT_MODAL_SELECTORS,
  DEFAULT_VIEWPORT,
  DEFAULT_GOTO_WAIT_UNTIL,
  ANTI_BOT_CONFIG,
  randomDelay,
};
