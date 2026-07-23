/**
 * Extract normalized visible text lines from a Playwright page (for local screening).
 */

/** Substrings dropped when normalizing lines (cookie CMP noise). */
const BOILERPLATE_SUBSTRINGS = [
  'accept all',
  'accept cookies',
  'cookie preferences',
  'we use cookies',
  'this website uses cookies',
];

/**
 * @param {string} line
 * @returns {string}
 */
function normalizeTextLine(line) {
  if (!line) return '';
  let s = line
    .replace(/\uFEFF/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return s;
}

/**
 * @param {string} line
 * @param {number} minLength
 * @returns {boolean}
 */
function isBoilerplateLine(line, minLength = 2) {
  if (!line || line.length < minLength) return true;
  for (const sub of BOILERPLATE_SUBSTRINGS) {
    if (line.includes(sub)) return true;
  }
  return false;
}

/**
 * Dedupe and filter raw lines from the browser.
 * @param {string[]} rawLines
 * @param {{ minLineLength?: number }} [opts]
 * @returns {string[]}
 */
function processVisibleLines(rawLines, opts = {}) {
  const minLen = opts.minLineLength ?? 2;
  const seen = new Set();
  const out = [];
  for (const raw of rawLines) {
    const line = normalizeTextLine(raw);
    if (isBoilerplateLine(line, minLen)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * Whether to include visible <img alt="..."> lines in extracted text.
 * @param {{ includeImageAlt?: boolean }} [opts]
 */
function isImageAltIncluded(opts = {}) {
  if (opts.includeImageAlt === true) return true;
  if (opts.includeImageAlt === false) return false;
  const v = process.env.PPD_INCLUDE_IMAGE_ALT;
  return v === '1' || v === 'true';
}

/**
 * Collect visible text lines in the browser (main frame).
 * @param {import('playwright').Page} page
 * @param {{ includeImageAlt?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
async function extractVisibleTextInBrowser(page, opts = {}) {
  const includeImageAlt = isImageAltIncluded(opts);
  // JSON-string transport (see memory: crawl-hard-cases) — the array return
  // throws on anti-bot pages tampering with Symbol.hasInstance.
  const json = await page.evaluate((includeAlt) => {
    const lines = [];
    const seen = new Set();

    function isVisible(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) < 0.05) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      return true;
    }

    function addLine(text) {
      const t = (text || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) return;
      if (seen.has(t)) return;
      seen.add(t);
      lines.push(t);
    }

    const blockTags = new Set([
      'P',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'LI',
      'TD',
      'TH',
      'FIGCAPTION',
      'BLOCKQUOTE',
      'LABEL',
      'BUTTON',
      'A',
      'SPAN',
      'DIV',
    ]);

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (blockTags.has(node.tagName) && isVisible(node)) {
        const text = node.innerText || '';
        if (text && text.length < 8000) {
          const parts = text.split('\n').map((s) => s.trim()).filter(Boolean);
          for (const p of parts) addLine(p);
        }
      }
      node = walker.nextNode();
    }

    if (includeAlt) {
      document.querySelectorAll('img[alt]').forEach((img) => {
        if (!isVisible(img)) return;
        const alt = img.getAttribute('alt');
        if (alt && alt.trim().length >= 2) addLine(alt);
      });
    }

    return JSON.stringify(lines);
  }, includeImageAlt);
  return json ? JSON.parse(json) : [];
}

/**
 * @param {import('playwright').Page} page
 * @param {{ minLineLength?: number }} [opts]
 * @returns {Promise<{ visibleText: string[], visibleTextCharCount: number }>}
 */
async function extractVisibleText(page, opts = {}) {
  const raw = await extractVisibleTextInBrowser(page, opts);
  const visibleText = processVisibleLines(raw, opts);
  const visibleTextCharCount = visibleText.reduce((n, l) => n + l.length, 0);
  return { visibleText, visibleTextCharCount };
}

/**
 * Page dimensions + title from browser.
 * @param {import('playwright').Page} page
 */
async function extractPageDimensions(page) {
  // JSON-string transport: the object return throws on anti-bot pages that tamper
  // with Symbol.hasInstance (breaks Playwright's structured serialization). See
  // memory: crawl-hard-cases.
  const json = await page.evaluate(() =>
    JSON.stringify({
      pageWidth: Math.max(
        document.documentElement?.scrollWidth || 0,
        document.body?.scrollWidth || 0,
        window.innerWidth || 0
      ),
      pageHeight: Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      ),
      title: document.title || '',
    })
  );
  return json ? JSON.parse(json) : { pageWidth: 0, pageHeight: 0, title: '' };
}

module.exports = {
  normalizeTextLine,
  processVisibleLines,
  isImageAltIncluded,
  extractVisibleText,
  extractPageDimensions,
  BOILERPLATE_SUBSTRINGS,
};
