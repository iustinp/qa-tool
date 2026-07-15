/* prototype: capture both IDFC pages, extract CLM, render both pears */
const fs = require('fs');
const path = require('path');
const { captureFullPageBuffer } = require('./lib/capture');
const { extractCanonicalLayout, renderPearHtml } = require('./lib/canonical-layout');
const { compareCanonical } = require('./lib/canonical-compare');
const { buildCanonicalReviewHtml } = require('./lib/canonical-review-html');

// Usage: node clm-proto.js <sourceUrl> <targetUrl> [outDir]
const SRC = process.argv[2] || 'https://www.idfcfirst.bank.in/credit-card/metal-credit-card/mayura';
const TGT = process.argv[3] || 'https://main--idfc--aemsites.aem.page/credit-card/metal-credit-card/mayura';
const OUT = process.argv[4] || './clm-out';

async function one(url, role) {
  const t = Date.now();
  const { metadata, onPageReadyResult } = await captureFullPageBuffer(url, {
    captureRole: role,
    onPageReady: async (page) => extractCanonicalLayout(page),
  });
  const clm = onPageReadyResult;
  console.log(
    `${role}: ${clm.nodes.length} nodes ` +
      `(text ${clm.nodes.filter((n) => n.kind === 'text').length}, ` +
      `img ${clm.nodes.filter((n) => n.kind === 'image').length}, ` +
      `bg ${clm.nodes.filter((n) => n.kind === 'bg-image').length}) ` +
      `canvas ${clm.width}x${clm.height} in ${((Date.now() - t) / 1000).toFixed(1)}s`
  );
  const fixed = clm.nodes.filter((n) => n.position === 'fixed' || n.position === 'sticky');
  console.log(`  fixed/sticky leaves: ${fixed.length}`);
  return clm;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const src = await one(SRC, 'source');
  const tgt = await one(TGT, 'target');
  fs.writeFileSync(path.join(OUT, 'source-clm.json'), JSON.stringify(src, null, 1));
  fs.writeFileSync(path.join(OUT, 'target-clm.json'), JSON.stringify(tgt, null, 1));
  fs.writeFileSync(path.join(OUT, 'source-pear.html'), renderPearHtml(src, { title: 'source pear' }));
  fs.writeFileSync(path.join(OUT, 'target-pear.html'), renderPearHtml(tgt, { title: 'target pear' }));

  const { audit, alignment } = compareCanonical(src, tgt);
  console.log(
    `\ncompare: ${audit.matchedCount} matched / ${audit.missingCount} missing / ` +
      `${audit.extraCount} extra / ${audit.movedCount} moved · ` +
      `coverage ${(audit.coverage * 100).toFixed(0)}% · drift ${audit.layoutDriftCount} · ` +
      `reflow-reconciled ${audit.reflowReconciledSegments}`
  );
  console.log('  sample missing:', audit.missing.slice(0, 8).map((m) => m.text));
  fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(audit, null, 1));
  fs.writeFileSync(
    path.join(OUT, 'canonical-review.html'),
    buildCanonicalReviewHtml({
      sourceUrl: SRC,
      targetUrl: TGT,
      sourceClm: src,
      targetClm: tgt,
      sourceDims: { w: src.width, h: src.height },
      targetDims: { w: tgt.width, h: tgt.height },
      alignment,
      audit,
    })
  );
  console.log('wrote pears + canonical-review.html to', OUT);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
