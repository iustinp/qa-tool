/**
 * Popup / cookie / overlay dismissal before screenshots.
 * Vision + DOM helpers in this package (lib/claude.js visionJson).
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const { visionJson, initializeClaudeClient } = require('./claude');

const OVERLAY_DETECTION_PROMPT = `You are an expert at identifying website overlays, cookie banners, modals, and pop-ups that block content.

Analyze this screenshot and identify ALL visible overlays, including:
- Cookie consent banners (GDPR, OneTrust, Cookiebot, etc.)
- Newsletter signup popups
- Age verification modals
- Chat widgets that obstruct content
- Promotional banners/modals
- Exit intent popups
- Any other element that appears ON TOP of the main content

For each overlay found, provide:
1. type: The category (cookie-banner, newsletter-popup, age-verification, chat-widget, promotional-banner, modal, banner, exit-intent, unknown-overlay)
2. description: Human-readable description
3. location: Where on screen (top, bottom, center, full-screen, corner)
4. approximate_bounds: Rough percentage of screen (e.g., "bottom 15%", "center 60%x40%", "full-screen")
5. visual_cues: Key visual elements that identify it (colors, text snippets, icons)
6. close_button: Description of how to close it if visible (e.g., "X button top-right", "Accept All button", "blue button with 'OK' text")
7. urgency: high (blocks all content), medium (blocks some content), low (minor obstruction)

IMPORTANT:
- Focus on elements that VISUALLY appear on top of content
- Include elements inside iframes if they appear as overlays
- Be specific about close button appearance and location
- If no overlays are found, return an empty array

Respond ONLY with valid JSON in this exact format:
{
  "overlays": [
    {
      "type": "cookie-banner",
      "description": "Cookie consent banner from OneTrust",
      "location": "bottom",
      "approximate_bounds": "bottom 20%",
      "visual_cues": ["blue accept button", "text about cookies", "white background"],
      "close_button": {
        "exists": true,
        "description": "Blue 'Accept All' button on the right side",
        "text_on_button": "Accept All",
        "position": "right side of banner"
      },
      "urgency": "medium"
    }
  ],
  "has_overlays": true,
  "page_appears_blocked": false
}`;

const ELEMENT_MATCHING_PROMPT = `You are matching a visually identified overlay to DOM elements.

OVERLAY DESCRIPTION:
{{OVERLAY_DESCRIPTION}}

DOM ELEMENTS (with bounding boxes relative to viewport):
{{ELEMENTS_JSON}}

Find the DOM element that BEST matches this overlay based on:
1. Position (bounding box should roughly match the described location)
2. Size (should cover approximately the described area)
3. Visual characteristics (tag type, classes, IDs that suggest overlay/modal/banner)

Return the SINGLE best matching element's selector. If the overlay is inside an iframe, indicate that.

Respond ONLY with valid JSON:
{
  "matched": true,
  "selector": "#cookie-banner or .modal-overlay",
  "element_id": "element_123",
  "confidence": "high|medium|low",
  "is_in_iframe": false,
  "iframe_index": null,
  "reason": "Brief explanation of why this element matches"
}

If no good match found:
{
  "matched": false,
  "reason": "Why no match was found"
}`;

const CLOSE_BUTTON_PROMPT = `You are finding the close/dismiss button for an overlay.

OVERLAY ELEMENT:
Selector: {{OVERLAY_SELECTOR}}
Type: {{OVERLAY_TYPE}}
Description: {{OVERLAY_DESCRIPTION}}
Visual close button hint: {{CLOSE_BUTTON_HINT}}

BUTTONS AND CLICKABLE ELEMENTS INSIDE THIS OVERLAY:
{{BUTTONS_JSON}}

Find the button that will CLOSE or ACCEPT this overlay. Priority:
1. "Accept All" / "Accept" buttons (for cookie banners - most common way to dismiss)
2. "I Agree" / "OK" / "Got it" buttons
3. Close (X) buttons
4. "Dismiss" / "Continue" buttons
5. Any button that would close the overlay

IMPORTANT: Return ONLY valid CSS selectors. DO NOT use:
- :contains() - not valid CSS
- :has-text() - not valid CSS
- jQuery-style selectors

Use ONLY standard CSS selectors like:
- #id
- .class
- button.class
- [aria-label="text"]
- button[type="submit"]

If there's an ID or class available, prefer that. Look at the buttons list and use the exact selector from there.

Respond ONLY with valid JSON:
{
  "found": true,
  "selector": "button.accept-all",
  "action": "click",
  "confidence": "high|medium|low",
  "button_text": "Accept All",
  "reason": "This is the primary accept button for the cookie banner"
}

If no close button found (will need to remove element instead):
{
  "found": false,
  "action": "remove",
  "reason": "No close button found, element should be removed from DOM"
}`;

function sanitizeSelector(selector) {
  if (!selector) return null;
  let sanitized = selector
    .replace(/:contains\([^)]*\)/gi, '')
    .replace(/:has-text\([^)]*\)/gi, '')
    .replace(/:has\([^)]*\)/gi, '')
    .replace(/:visible/gi, '')
    .replace(/:hidden/gi, '')
    .replace(/:first/gi, ':first-of-type')
    .replace(/:last/gi, ':last-of-type')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*$/g, '')
    .replace(/^\s*,/g, '')
    .trim();

  if (!sanitized || sanitized === '' || sanitized === ',' || sanitized.endsWith(',')) {
    return null;
  }

  if (sanitized.includes(',')) {
    const parts = sanitized.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) sanitized = parts[0];
  }

  return sanitized;
}

async function extractPageElements(frame, viewport, isMainFrame = true, frameUrl = '') {
  const elements = await frame.evaluate((viewportSize) => {
    const results = [];
    const potentialOverlaySelectors = [
      '[id*="cookie" i]',
      '[class*="cookie" i]',
      '[id*="consent" i]',
      '[class*="consent" i]',
      '[id*="gdpr" i]',
      '[class*="gdpr" i]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[class*="modal" i]',
      '[class*="popup" i]',
      '[class*="overlay" i]',
      '[id*="modal" i]',
      '[id*="popup" i]',
      '[class*="banner" i]',
      '[class*="notification" i]',
      'aside',
      'dialog',
      '[class*="notice" i]',
      '[class*="alert" i]',
      'div[style*="position: fixed"]',
      'div[style*="position:fixed"]',
      'div[style*="z-index"]',
    ];

    const allElements = new Set();
    for (const selector of potentialOverlaySelectors) {
      try {
        document.querySelectorAll(selector).forEach((el) => allElements.add(el));
      } catch {
        /* ignore */
      }
    }

    document.querySelectorAll('*').forEach((el) => {
      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex, 10);
      if (!Number.isNaN(zIndex) && zIndex >= 100) {
        allElements.add(el);
      }
      if (style.position === 'fixed' || style.position === 'sticky') {
        allElements.add(el);
      }
    });

    let elementIndex = 0;
    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      if (rect.width < 50 || rect.height < 30) continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (parseFloat(style.opacity) < 0.1) continue;

      let selector = '';
      if (el.id) {
        selector = `#${CSS.escape(el.id)}`;
      } else if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(' ').filter((c) => c && !c.includes(' '));
        if (classes.length > 0) {
          selector = `.${CSS.escape(classes[0])}`;
        }
      }

      if (!selector) {
        selector = el.tagName.toLowerCase();
      }

      results.push({
        id: `element_${elementIndex++}`,
        selector,
        tagName: el.tagName,
        id_attr: el.id || null,
        className: el.className || null,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          xPercent: ((rect.x / viewportSize.width) * 100).toFixed(1),
          yPercent: ((rect.y / viewportSize.height) * 100).toFixed(1),
          widthPercent: ((rect.width / viewportSize.width) * 100).toFixed(1),
          heightPercent: ((rect.height / viewportSize.height) * 100).toFixed(1),
        },
        style: {
          position: style.position,
          zIndex: style.zIndex,
          display: style.display,
        },
        textPreview: el.textContent?.substring(0, 100)?.trim() || '',
        location:
          rect.y < viewportSize.height * 0.3
            ? 'top'
            : rect.y > viewportSize.height * 0.7
              ? 'bottom'
              : 'center',
      });
    }

    return results;
  }, viewport);

  return elements.map((el) => ({
    ...el,
    isInIframe: !isMainFrame,
    frameUrl,
  }));
}

async function extractButtonsInOverlay(frame, overlaySelector) {
  return frame.evaluate((selector) => {
    const overlay = document.querySelector(selector);
    if (!overlay) return [];

    const buttons = [];
    const clickables = overlay.querySelectorAll(
      'button, [role="button"], a, input[type="button"], input[type="submit"], [onclick], [class*="btn"], [class*="button"]'
    );

    let btnIndex = 0;
    clickables.forEach((btn) => {
      const rect = btn.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;

      let btnSelector = '';
      if (btn.id) {
        btnSelector = `#${CSS.escape(btn.id)}`;
      } else if (btn.className && typeof btn.className === 'string') {
        const classes = btn.className.split(' ').filter((c) => c && !c.includes(' '));
        if (classes.length > 0) {
          btnSelector = `${btn.tagName.toLowerCase()}.${CSS.escape(classes[0])}`;
        }
      }
      if (!btnSelector) {
        btnSelector = btn.tagName.toLowerCase();
      }

      buttons.push({
        id: `btn_${btnIndex++}`,
        selector: btnSelector,
        tagName: btn.tagName,
        text: btn.textContent?.trim()?.substring(0, 50) || '',
        ariaLabel: btn.getAttribute('aria-label') || null,
        title: btn.getAttribute('title') || null,
        className: btn.className || null,
        id_attr: btn.id || null,
        type: btn.getAttribute('type') || null,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      });
    });

    return buttons;
  }, overlaySelector);
}

function calculateRemovalPriority(overlay) {
  let priority = 0;

  if (overlay.type === 'cookie-banner') priority += 100;
  if (overlay.type === 'age-verification') priority += 150;
  if (overlay.urgency === 'high') priority += 50;
  if (overlay.urgency === 'medium') priority += 25;
  if (overlay.location === 'center' || overlay.approximate_bounds?.includes('full')) {
    priority += 30;
  }

  return priority;
}

async function analyzeViewportBuffer(viewportPngBuffer) {
  const result = await visionJson(
    [
      { type: 'image_buffer', buffer: viewportPngBuffer },
      { type: 'text', text: OVERLAY_DETECTION_PROMPT },
    ],
    4096
  );
  const parsed = result.parsed;
  if (parsed && Array.isArray(parsed.overlays)) {
    return parsed;
  }
  return { overlays: [], has_overlays: false, page_appears_blocked: false };
}

async function matchOverlayToElement(overlayDescription, elements) {
  const prompt = ELEMENT_MATCHING_PROMPT.replace(
    '{{OVERLAY_DESCRIPTION}}',
    JSON.stringify(overlayDescription, null, 2)
  ).replace('{{ELEMENTS_JSON}}', JSON.stringify(elements, null, 2));

  const result = await visionJson([{ type: 'text', text: prompt }], 1024);
  return result.parsed || { matched: false, reason: 'parse_failed' };
}

async function findCloseButtonWithClaude(overlayInfo, buttons, visualOverlay) {
  const closeHint = visualOverlay.close_button?.exists
    ? `${visualOverlay.close_button.description} - text: "${visualOverlay.close_button.text_on_button || ''}"`
    : 'Not visible';

  const prompt = CLOSE_BUTTON_PROMPT.replace('{{OVERLAY_SELECTOR}}', overlayInfo.selector || '')
    .replace('{{OVERLAY_TYPE}}', overlayInfo.type || '')
    .replace('{{OVERLAY_DESCRIPTION}}', overlayInfo.description || '')
    .replace('{{CLOSE_BUTTON_HINT}}', closeHint)
    .replace('{{BUTTONS_JSON}}', JSON.stringify(buttons, null, 2));

  const result = await visionJson([{ type: 'text', text: prompt }], 1024);
  return result.parsed || { found: false, action: 'remove', reason: 'parse_failed' };
}

async function removeBackdropNoise(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      await frame.evaluate(() => {
        const backdrops = document.querySelectorAll(
          '.sp-overlay, .modal-backdrop, .overlay-backdrop, ' +
            '[class*="backdrop"], [class*="overlay-bg"], ' +
            'div[style*="position: fixed"][style*="background"]'
        );
        backdrops.forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5) {
            el.remove();
          }
        });
      });
    } catch {
      /* cross-origin iframe */
    }
  }
}

/**
 * After load + storage tricks (caller runs those), detect overlays via vision and dismiss.
 * @param {(subevent: string, data: object) => void | Promise<void>} [options.logStep]
 * @returns {{ attempted: boolean, overlayCount: number, dismissed: number, errors: string[], timings: object }}
 */
async function dismissOverlaysOnPage(page, options = {}) {
  const maxOverlays = options.maxOverlays ?? 8;
  const errors = [];
  const logStep = options.logStep;
  const L = async (name, data) => {
    if (logStep) await logStep(name, data);
  };

  const timings = {
    viewportShotMs: 0,
    visionDetectMs: 0,
    domGatherMs: 0,
    rounds: [],
    backdropCleanupMs: 0,
  };

  await initializeClaudeClient();

  const viewport = page.viewportSize();
  let tick = Date.now();
  const viewportPngBuffer = await page.screenshot({ fullPage: false, type: 'png' });
  timings.viewportShotMs = Date.now() - tick;
  await L('viewport_shot', { ms: timings.viewportShotMs, bytes: viewportPngBuffer.length });

  let claudeAnalysis;
  try {
    tick = Date.now();
    claudeAnalysis = await analyzeViewportBuffer(viewportPngBuffer);
    timings.visionDetectMs = Date.now() - tick;
    await L('vision_detect', { ms: timings.visionDetectMs });
  } catch (e) {
    errors.push(`overlay vision detection: ${e.message}`);
    return { attempted: true, overlayCount: 0, dismissed: 0, errors, timings };
  }

  if (
    !claudeAnalysis.has_overlays ||
    !claudeAnalysis.overlays ||
    claudeAnalysis.overlays.length === 0
  ) {
    await L('skipped_no_overlays', {});
    return { attempted: true, overlayCount: 0, dismissed: 0, errors, timings };
  }

  const frames = page.frames();
  let allElements = [];

  tick = Date.now();
  const mainElements = await extractPageElements(page.mainFrame(), viewport, true, '');
  allElements = allElements.concat(mainElements);

  for (let i = 0; i < frames.length; i++) {
    if (frames[i] === page.mainFrame()) continue;
    try {
      const iframeElements = await extractPageElements(
        frames[i],
        viewport,
        false,
        frames[i].url()
      );
      allElements = allElements.concat(iframeElements);
    } catch {
      /* ignore */
    }
  }
  timings.domGatherMs = Date.now() - tick;
  await L('dom_candidates_gathered', {
    ms: timings.domGatherMs,
    count: allElements.length,
  });

  const sorted = [...claudeAnalysis.overlays]
    .map((o) => ({ o, p: calculateRemovalPriority(o) }))
    .sort((a, b) => b.p - a.p)
    .map((x) => x.o)
    .slice(0, maxOverlays);

  let dismissed = 0;
  let roundIdx = 0;

  for (const visualOverlay of sorted) {
    roundIdx += 1;
    const roundTimings = {
      index: roundIdx,
      overlayType: visualOverlay.type,
      matchMs: 0,
      buttonsExtractMs: 0,
      closeMs: 0,
      domActionMs: 0,
      matched: false,
      dismissed: false,
    };

    let matchResult;
    try {
      tick = Date.now();
      matchResult = await matchOverlayToElement(visualOverlay, allElements);
      roundTimings.matchMs = Date.now() - tick;
      await L('round_match_vision', {
        round: roundIdx,
        type: visualOverlay.type,
        ms: roundTimings.matchMs,
        matched: Boolean(matchResult?.matched),
      });
    } catch (e) {
      errors.push(`match overlay: ${e.message}`);
      timings.rounds.push(roundTimings);
      continue;
    }

    if (!matchResult || !matchResult.matched) {
      timings.rounds.push(roundTimings);
      continue;
    }
    roundTimings.matched = true;

    const matchedElement = allElements.find(
      (el) => el.selector === matchResult.selector || el.id === matchResult.element_id
    );

    const isInIframe = matchResult.is_in_iframe || matchedElement?.isInIframe;
    const frameUrl = matchedElement?.frameUrl || '';

    let targetFrame = page.mainFrame();
    if (isInIframe && frameUrl) {
      const iframe = frames.find((f) => f.url() === frameUrl);
      if (iframe) targetFrame = iframe;
    }

    let buttons = [];
    try {
      tick = Date.now();
      buttons = await extractButtonsInOverlay(targetFrame, matchResult.selector);
      roundTimings.buttonsExtractMs = Date.now() - tick;
    } catch {
      buttons = [];
    }

    let closeResult;
    try {
      tick = Date.now();
      closeResult = await findCloseButtonWithClaude(
        {
          selector: matchResult.selector,
          type: visualOverlay.type,
          description: visualOverlay.description,
        },
        buttons,
        visualOverlay
      );
      roundTimings.closeMs = Date.now() - tick;
      await L('round_close_vision', {
        round: roundIdx,
        ms: roundTimings.closeMs,
        found: Boolean(closeResult?.found),
      });
    } catch (e) {
      errors.push(`close button: ${e.message}`);
      timings.rounds.push(roundTimings);
      continue;
    }

    const overlaySelector = sanitizeSelector(matchResult.selector);
    const targetSelector = sanitizeSelector(
      closeResult.found ? closeResult.selector : matchResult.selector
    );

    const actionT0 = Date.now();
    try {
      if (closeResult.found) {
        const selectorToUse = targetSelector || overlaySelector;
        if (!selectorToUse) {
          roundTimings.domActionMs = Date.now() - actionT0;
          timings.rounds.push(roundTimings);
          continue;
        }

        const element = await targetFrame.$(selectorToUse);
        if (element) {
          try {
            await targetFrame.evaluate((selector) => {
              const el = document.querySelector(selector);
              if (el) el.click();
            }, selectorToUse);
            await delay(500);
          } catch {
            try {
              await element.click({ force: true, timeout: 5000 });
              await delay(500);
            } catch {
              await targetFrame.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                  const parent =
                    el.closest('[class*="overlay"]') ||
                    el.closest('[class*="modal"]') ||
                    el.closest('[class*="popup"]') ||
                    el.closest('[role="dialog"]');
                  if (parent) parent.remove();
                  else el.remove();
                }
              }, overlaySelector || selectorToUse);
            }
          }
        } else if (overlaySelector) {
          await targetFrame.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (el) el.remove();
          }, overlaySelector);
        }
      } else {
        const selectorToUse = overlaySelector || targetSelector;
        if (selectorToUse) {
          await targetFrame.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (el) el.remove();
          }, selectorToUse);
        }
      }

      dismissed += 1;
      roundTimings.dismissed = true;
      await delay(300);
    } catch (e) {
      errors.push(`dismiss action: ${e.message}`);
      try {
        const fallback = sanitizeSelector(matchResult.selector);
        if (fallback) {
          await targetFrame.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (el) el.remove();
          }, fallback);
          dismissed += 1;
          roundTimings.dismissed = true;
        }
      } catch {
        /* ignore */
      }
    }
    roundTimings.domActionMs = Date.now() - actionT0;
    await L('round_dom_action', {
      round: roundIdx,
      ms: roundTimings.domActionMs,
      dismissed: roundTimings.dismissed,
    });
    timings.rounds.push(roundTimings);
  }

  tick = Date.now();
  await removeBackdropNoise(page);
  timings.backdropCleanupMs = Date.now() - tick;
  await L('backdrop_cleanup', { ms: timings.backdropCleanupMs });

  return {
    attempted: true,
    overlayCount: claudeAnalysis.overlays.length,
    dismissed,
    errors,
    timings,
  };
}

module.exports = {
  dismissOverlaysOnPage,
  sanitizeSelector,
};
