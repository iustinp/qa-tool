/*
 * Chrome vs content-block classification (issue #65, step #1), reusable.
 *
 * Classifies each recurring descriptor by its content VOCABULARY across the corpus:
 * bounded vocabulary (small distinct-per-page) = site chrome / fixed label; growing
 * vocabulary = varying content (incl. a reused "recent posts" pool). See poc-chrome.js
 * header for the three-regime rationale.
 */

const { descriptor, contentValue } = require('./signature');

const MIN_PAGES = 3;        // below this = one-off scatter, not classified
const CONTENT_DPP = 0.20;   // distinct-per-page >= this -> vocabulary grows -> content
const BOUNDED_DPP = 0.12;   // distinct-per-page <= this -> bounded vocabulary (chrome/label)
const PERPAGE_CHROME = 1.3; // <= this many instances/page -> once-per-page (site chrome)

// pears: [{url, nodes}] -> { rows:[{key,pages,instances,distinct,distinctPerPage,perPage,vocabRatio,bucket,hasImg,samples}], keyBucket:Map<key,bucket> }
function classifyDescriptors(pears) {
  const desc = new Map();
  for (const p of pears) {
    for (const n of p.nodes) {
      const key = descriptor(n, p.nodes);
      let e = desc.get(key);
      if (!e) { e = { pages: new Set(), count: 0, values: new Set(), samples: new Set(), hasImg: key.includes('IMG') }; desc.set(key, e); }
      e.pages.add(p.url); e.count++;
      const v = contentValue(n);
      if (v) { e.values.add(v); if (e.samples.size < 4) e.samples.add(v.replace(/^https?:\/\/.*\//, '…/').slice(0, 42)); }
    }
  }
  const rows = [];
  const keyBucket = new Map();
  for (const [key, e] of desc) {
    const pages = e.pages.size, instances = e.count, distinct = e.values.size;
    const distinctPerPage = distinct / pages, perPage = instances / pages, vocabRatio = distinct / instances;
    let bucket;
    if (pages < MIN_PAGES) bucket = 'RARE';
    else if (distinctPerPage >= CONTENT_DPP) bucket = 'CONTENT';
    else if (distinctPerPage <= BOUNDED_DPP) bucket = perPage <= PERPAGE_CHROME ? 'CHROME' : 'LABEL';
    else bucket = 'AMBIG';
    keyBucket.set(key, bucket);
    rows.push({ key, pages, instances, distinct, distinctPerPage, perPage, vocabRatio, bucket, hasImg: e.hasImg, samples: [...e.samples] });
  }
  return { rows, keyBucket };
}

// descriptor buckets that mean "site frame / fixed boilerplate", not varying content
const CHROME_BUCKETS = new Set(['CHROME', 'LABEL']);

module.exports = { classifyDescriptors, CHROME_BUCKETS, MIN_PAGES, CONTENT_DPP, BOUNDED_DPP, PERPAGE_CHROME };
