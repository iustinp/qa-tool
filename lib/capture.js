const { chromium } = require('playwright');
const { dismissOverlaysOnPage } = require('./overlay-dismiss');
const { extractVisibleText, extractPageDimensions } = require('./visible-text');
const { extractExpandedVisibleText, isTextExpansionEnabled } = require('./text-expansion');
const { resolveProfile } = require('./profiles');

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

      t = Date.now();
      const buffer = await page.screenshot({ fullPage: true, type: 'png' });
      await emit('screenshot_full_page', {
        ms: Date.now() - t,
        bytes: buffer.length,
        attempt,
      });

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
        };
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
  DEFAULT_VIEWPORT,
  DEFAULT_GOTO_WAIT_UNTIL,
  ANTI_BOT_CONFIG,
  randomDelay,
};
