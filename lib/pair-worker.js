const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { visionJson } = require('./claude');
const {
  capturePage,
  primaryProfile,
  summarizePageCapture,
} = require('./page-capture');
const { screenPair, isScreeningEnabled } = require('./pair-screening');
const { auditVisibleText, createSkippedTextAudit } = require('./text-audit');
const { isTextExpansionEnabled, getTextExpansionMode } = require('./text-expansion');
const {
  SEGMENT_INTERACTION_ADDENDUM,
  isBlockInteractionManifestEnabled,
  isSegmentInteractionReplayEnabled,
  analyzeCropInteraction,
  manifestEntryFromSegment,
} = require('./block-interaction');
const { replayInteractionManifestForText } = require('./interaction-replay');
const {
  loadMatchThresholds,
  evaluateMatchAcceptance,
  buildMatchPrompt,
} = require('./match-validation');
const {
  CARD_ROW_EXPAND_ADDENDUM,
  cardRowExpandRetryAddendum,
  isIncompleteCardRow,
  needsCardRowExpansion,
  shouldMergeFragmentIntoPrev,
  extendIncompleteCardRowBbox,
  mergeCardFragmentRects,
  minCardRowHeightPx,
} = require('./segment-guards');

function linesForTextAudit(meta) {
  if (!meta) return [];
  if (isTextExpansionEnabled() && Array.isArray(meta.expandedVisibleText)) {
    return meta.expandedVisibleText;
  }
  return meta.visibleText || [];
}
const {
  resizeForVision,
  normToPixelsFull,
  pixelsToNormBbox,
  cropBelowRect,
  extractCrop,
  applyTargetStitchRemovals,
  resolveVisionMaxEdges,
} = require('./image-utils');

const BBOX_TIGHTNESS_RULES = `**Bbox must be surgically tight at SECTION boundaries (critical):**
- Wrap **one complete logical section** — not a fragment of it.
- **Exclude** the next section below and any section above (do not bleed into neighboring heroes, card rows, footers, or background bands).
- **Width:** use full viewport width only when the block is truly edge-to-edge; otherwise clip to the content column.
- A loose box that includes the **next** section causes false deletions — but splitting **one** section into image-row + text-row is worse (broken matching).
- At **section** edges: prefer slightly too small over bleeding into the next section; **within** a card row or hero, prefer **one combined box** over splitting.`;

const ATOMIC_BLOCK_GROUPING_RULES = `**Keep logical sections whole — do NOT split card rows (critical):**

Many pages use **card rows**: a row of images/icons with headlines, links, or CTAs **directly below** each card. These are **one section**, not two.

**Always ONE bbox for:**
- **Card / tile rows** — section title (if any) + all card images/thumbnails + **all** captions, link lines, and CTAs that belong to those cards. Never segment “image row” and “text/link row” separately.
- **Promo card strips** (e.g. three horizontal promo cards with text under each image).
- **Hero / banner bands** — background image + headline + body copy + buttons in one band.
- **Icon category rows** — icons and their labels together.

**Do NOT** draw a bbox boundary between:
- card photos and the link/title line under them,
- a section heading and the card grid it introduces (same segment),
- columns that share one section title or one continuous background.

**Wrong:** segment 1 = three card images only; segment 2 = three link titles below.
**Right:** one segment = “Happening now” (or similar) including images **and** link titles.

When unsure if a lower text strip belongs to the card row above, **include it** in that row’s bbox.`;

const SEGMENT_PROMPT_FULL_PAGE = `You are analyzing a **full-page website screenshot** (entire page from top to bottom after scrolling).

Find the **single next** block in strict **top-to-bottom reading order** — always the **topmost major horizontal band** that has not been segmented yet.

**Headers and navigation first:** If the page has a **site header, logo row, primary navigation, menu bar, or sticky/fixed bar** along the **top** (even if it **visually overlaps** a hero image or banner behind it), you MUST segment **that header/nav band as its own bbox first** — do **not** skip it in favor of the hero or main headline below. The hero / main visual section comes **after** the header has been isolated.

**Overlap:** When an opaque or translucent header sits on top of a hero photo, draw the bbox around **only the header/nav strip** (logo, links, utilities), not the whole hero.

Prefer meaningful UI regions over stray icons only; but **nav/header rows are never “tiny chrome”** to skip — they are full segments.

${ATOMIC_BLOCK_GROUPING_RULES}

${BBOX_TIGHTNESS_RULES}

Respond with ONLY valid JSON:
{
  "done": false,
  "label": "short description e.g. site header + nav, hero, card row (images + link titles), footer",
  "bbox": {
    "x": 0,
    "y": 0,
    "width": 0,
    "height": 0
  }
}

Rules for bbox:
- Coordinates are **normalized** 0–1 relative to this image: x,y is top-left; width/height are fractions of image width/height.
- The box must tightly wrap **only** that topmost segment (nothing higher in the image is left unboxed for later).
- If the page has no meaningful content left to segment, set "done": true and omit bbox.

If done:
{ "done": true }`;

const SEGMENT_PROMPT_CONTINUATION = `You are analyzing a **continuation screenshot**: only the lower part of the page remains after upper sections were compared and removed.

Find the **next** block in **top-to-bottom** order starting from the **top edge of this image**.

If a **sticky header, compact nav, or secondary bar** still appears along the **top** of this crop (common after scrolling), segment **that band first** — do not skip it as “chrome” in favor of content below.

Otherwise segment the next major section (hero fragment, cards, etc.).

${ATOMIC_BLOCK_GROUPING_RULES}

${BBOX_TIGHTNESS_RULES}

Respond with ONLY valid JSON:
{
  "done": false,
  "label": "short description e.g. sticky nav, hero, card row (images + link titles), footer",
  "bbox": {
    "x": 0,
    "y": 0,
    "width": 0,
    "height": 0
  }
}

Rules for bbox:
- Coordinates are **normalized** 0–1 relative to this image: x,y is top-left; width/height are fractions of image width/height.
- The box must tightly wrap the **topmost** meaningful block in this image.
- If the remainder is only white/background with no meaningful block, set "done": true and omit bbox.

If done:
{ "done": true }`;

function segmentPromptForIteration(iter) {
  const base = iter <= 1 ? SEGMENT_PROMPT_FULL_PAGE : SEGMENT_PROMPT_CONTINUATION;
  if (isBlockInteractionManifestEnabled()) {
    return base + SEGMENT_INTERACTION_ADDENDUM;
  }
  return base;
}

/**
 * Merge a card link/text fragment into the previous card-row segment (same page coords).
 */
function tryApplyCardFragmentMerge({
  iter,
  rectFull,
  label,
  report,
  workByIter,
  remainderTopPx,
  minBlockHeight,
}) {
  const prev = [...report.iterations].reverse().find((i) => !i.skipped && i.segmentBbox);
  if (!prev || prev.iter !== iter - 1) return null;
  if (!shouldMergeFragmentIntoPrev(prev, label, rectFull)) return null;

  const prevTag = String(prev.iter).padStart(3, '0');
  const prevStartPath = path.join(workByIter, `iter-${prevTag}-start-source.png`);
  if (!fs.existsSync(prevStartPath)) return null;

  const mergedRect = mergeCardFragmentRects(prev.segmentBbox, rectFull);
  if (mergedRect.height < minBlockHeight) return null;

  const revokedTargetMatch = prev.matchFound === true;
  report.iterations = report.iterations.filter((i) => i.iter !== prev.iter);
  report.missing = report.missing.filter((m) => m.iter !== prev.iter);
  if (revokedTargetMatch) {
    report.targetMatchedRegions = report.targetMatchedRegions.filter(
      (r) => r.iter !== prev.iter
    );
  }

  return {
    sourceWorking: fs.readFileSync(prevStartPath),
    mergedRect,
    remainderTopPx: prev.sourceBboxOnPage?.y ?? remainderTopPx,
    label: `${prev.label || 'card row'} (images + links)`,
    mergedFromIters: [prev.iter, iter],
    revokedTargetMatch,
    revokedPrevIter: prev.iter,
  };
}

/**
 * Re-ask vision until card-row bbox is tall enough or stops growing.
 */
async function expandCardRowSegmentLoop({
  seg,
  segVision,
  iter,
  remainderHeightPx,
  segmentPromptText,
  rateLimiter,
  visionJsonFn,
  dbg,
}) {
  let segToUse = seg;
  let lastHeightPx = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (!needsCardRowExpansion(segToUse, remainderHeightPx)) break;

    const hPx = Math.round((segToUse.bbox?.height || 0) * remainderHeightPx);
    await rateLimiter.acquire();
    const expandT0 = Date.now();
    const addendum =
      attempt === 0
        ? CARD_ROW_EXPAND_ADDENDUM
        : cardRowExpandRetryAddendum(hPx, remainderHeightPx);

    const expandResult = await visionJsonFn(
      [
        { type: 'image_buffer', buffer: segVision.buffer },
        { type: 'text', text: `${segmentPromptText}${addendum}` },
      ],
      2048
    );
    const expanded = expandResult.parsed;
    if (!expanded?.bbox || expanded.done === true) break;

    const newHeightPx = Math.round(expanded.bbox.height * remainderHeightPx);
    await dbg('segment_card_row_expanded', {
      iter,
      attempt: attempt + 1,
      ms: Date.now() - expandT0,
      prevHeightPx: hPx,
      newHeightPx,
      minRequiredPx: minCardRowHeightPx(),
    });

    if (newHeightPx <= lastHeightPx && lastHeightPx > 0) break;
    lastHeightPx = newHeightPx;
    segToUse = expanded;
    if (newHeightPx >= minCardRowHeightPx()) break;
  }

  return segToUse;
}

async function writeTextAuditArtifact(pairDir, source, target, screeningVerdict, textAudit) {
  fs.writeFileSync(
    path.join(pairDir, 'text-audit.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        sourceUrl: source,
        targetUrl: target,
        screeningVerdict,
        ...textAudit,
      },
      null,
      2
    )
  );
}

async function runPairTextAudit(report, sourceMetadata, targetMetadata, screeningVerdict, dbg) {
  const sourceAuditLines = linesForTextAudit(sourceMetadata);
  const targetAuditLines = linesForTextAudit(targetMetadata);
  await dbg('text_audit_start', {
    screeningVerdict,
    auditMode: isTextExpansionEnabled() ? 'expanded' : 'visible',
    sourceLineCount: sourceAuditLines.length,
    targetLineCount: targetAuditLines.length,
    sourceBaselineLineCount: sourceMetadata?.visibleText?.length ?? 0,
    targetBaselineLineCount: targetMetadata?.visibleText?.length ?? 0,
  });
  const textAuditT0 = Date.now();
  report.textAudit = auditVisibleText(sourceAuditLines, targetAuditLines, {
    auditMode: isTextExpansionEnabled() ? 'expanded' : 'visible',
    sourceBaselineLines: sourceMetadata?.visibleText || [],
    targetBaselineLines: targetMetadata?.visibleText || [],
    sourceExpansion: sourceMetadata?.textExpansion || null,
    targetExpansion: targetMetadata?.textExpansion || null,
  });
  await dbg('text_audit_done', {
    ms: Date.now() - textAuditT0,
    screeningVerdict,
    auditMode: report.textAudit.auditMode,
    status: report.textAudit.status,
    sourceLineCount: report.textAudit.sourceLineCount,
    matchedLineCount: report.textAudit.matchedLineCount,
    missingLineCount: report.textAudit.missingLineCount,
    coverage: report.textAudit.coverage,
    sourceLinesAddedByExpansion: report.textAudit.sourceLinesAddedByExpansion,
  });
  return report.textAudit;
}

const EXTRA_TARGET_SCAN_PROMPT = `You are analyzing the **full target page** screenshot.

Some regions were already matched to source blocks (normalized bboxes below). List any **major content bands** on the target that are **not** covered by those matches — extra sections, replacement content where source had something else, or leftover blocks after all source content was accounted for.

Ignore: tiny chrome, repeated nav already matched, bare whitespace.

Respond with ONLY valid JSON:
{
  "blocks": [
    { "label": "short description", "bbox": { "x": 0, "y": 0, "width": 0, "height": 0 } }
  ]
}

Use normalized 0–1 coordinates on this image. If nothing significant remains, return { "blocks": [] }.`;

async function scanExtraTargetBlocks(targetFullBuffer, matchedRegions, opts) {
  const meta = await sharp(targetFullBuffer).metadata();
  const tw = meta.width || 1;
  const th = meta.height || 1;
  const vision = await resizeForVision(targetFullBuffer, opts.matchTargetMaxEdge);
  const parts = [
    { type: 'image_buffer', buffer: vision.buffer },
    {
      type: 'text',
      text: `${EXTRA_TARGET_SCAN_PROMPT}\n\nAlready matched (normalized):\n${JSON.stringify(
        matchedRegions.map((m) => ({ iter: m.iter, label: m.label, bbox: m.bboxNorm })),
        null,
        2
      )}\n\nImage: ${vision.visionWidth}x${vision.visionHeight}`,
    },
  ];
  await opts.rateLimiter.acquire();
  const result = await visionJson(parts, 2048);
  const parsed = result.parsed;
  if (!parsed || !Array.isArray(parsed.blocks)) {
    return { blocks: [], rawPreview: result.rawText?.slice(0, 500) || null };
  }
  const blocks = [];
  for (const b of parsed.blocks) {
    if (!b?.bbox) continue;
    const rect = normToPixelsFull(b.bbox, tw, th);
    if (rect.height < (opts.minBlockHeight || 40) || rect.width < (opts.minBlockWidth || 50)) {
      continue;
    }
    blocks.push({
      label: b.label || null,
      bbox: rect,
      bboxNorm: b.bbox,
    });
  }
  return { blocks, rawPreview: null };
}

function slugForPair(sourceUrl, targetUrl, index) {
  const h = crypto
    .createHash('sha256')
    .update(`${sourceUrl}|${targetUrl}`)
    .digest('hex')
    .slice(0, 10);
  return `pair-${String(index).padStart(4, '0')}-${h}`;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * @returns {Promise<object>}
 */
async function processPair(
  { source, target },
  index,
  outRoot,
  options = {}
) {
  const {
    rateLimiter,
    maxIterations = 40,
    minBlockWidth = 50,
    minBlockHeight = 40,
    captureOptions = {},
    visionMaxEdges: visionMaxEdgesOverride,
    runLogger,
    skipScreening = false,
    screeningOnly = false,
    profiles = ['desktop'],
  } = options;

  const visionEdges = resolveVisionMaxEdges(process.env, visionMaxEdgesOverride || {});

  const envDismiss =
    process.env.PPD_DISMISS_OVERLAYS !== '0' &&
    process.env.PPD_DISMISS_OVERLAYS !== 'false';
  const resolvedCaptureOptions = {
    dismissOverlays: envDismiss,
    overlayDismissMax: parseInt(process.env.PPD_OVERLAY_DISMISS_MAX || '8', 10),
    overlayLazyMs: parseInt(process.env.PPD_OVERLAY_LAZY_MS || '4000', 10),
    ...(process.env.PPD_GOTO_WAIT_UNTIL
      ? { gotoWaitUntil: process.env.PPD_GOTO_WAIT_UNTIL.trim() }
      : {}),
    ...captureOptions,
  };

  const slug = slugForPair(source, target, index);
  const dbg = (event, data) =>
    runLogger ? runLogger.event(slug, event, data || {}) : Promise.resolve();
  const pairDir = path.join(outRoot, 'pairs', slug);
  const shotsDir = path.join(pairDir, 'screenshots');
  const workDir = path.join(pairDir, 'working');
  const cropsDir = path.join(pairDir, 'crops');
  ensureDir(shotsDir);
  ensureDir(workDir);
  ensureDir(cropsDir);
  const workByIter = path.join(workDir, 'by-iter');
  ensureDir(workByIter);

  await dbg('pair_start', {
    sourceUrl: source,
    targetUrl: target,
    index,
    maxIterations,
    minBlockWidth,
    minBlockHeight,
    visionMaxEdgesPx: visionEdges,
  });

  const report = {
    slug,
    index,
    sourceUrl: source,
    targetUrl: target,
    startedAt: new Date().toISOString(),
    captureError: null,
    sourceCapture: null,
    targetCapture: null,
    iterations: [],
    missing: [],
    targetMatchedRegions: [],
    reorderedMatches: [],
    extraOnTarget: [],
    screening: null,
    textAudit: null,
    interactionManifest: { regions: [] },
    deferredTextAudit: false,
    finishedReason: null,
    endedAt: null,
  };

  let sourceWorking;
  let targetFull;
  let targetWorking;
  let srcBuf;
  let tgtBuf;
  let sourceMetadata = null;
  let targetMetadata = null;

  const capT0 = Date.now();
  const captureLog = runLogger ? (event, data) => dbg(event, data) : undefined;

  try {
    await dbg('capture_start', { source, target, profiles });
    const [sourceCapture, targetCapture] = await Promise.all([
      capturePage(source, {
        role: 'source',
        profiles,
        captureOptions: resolvedCaptureOptions,
        logCaptureStep: captureLog,
      }),
      capturePage(target, {
        role: 'target',
        profiles,
        captureOptions: resolvedCaptureOptions,
        logCaptureStep: captureLog,
      }),
    ]);
    // Phase 0 operates on the primary (desktop) profile's base state; the model
    // now carries every profile/state so later phases can iterate over them.
    report.sourceCapture = summarizePageCapture(sourceCapture);
    report.targetCapture = summarizePageCapture(targetCapture);
    const srcPrimary = primaryProfile(sourceCapture);
    const tgtPrimary = primaryProfile(targetCapture);
    srcBuf = srcPrimary.buffer;
    tgtBuf = tgtPrimary.buffer;
    sourceMetadata = srcPrimary.metadata || null;
    targetMetadata = tgtPrimary.metadata || null;
    fs.writeFileSync(path.join(shotsDir, 'source-full.png'), srcBuf);
    fs.writeFileSync(path.join(shotsDir, 'target-full.png'), tgtBuf);
    sourceWorking = Buffer.from(srcBuf);
    targetFull = Buffer.from(tgtBuf);
    targetWorking = Buffer.from(tgtBuf);
    await dbg('capture_done', {
      ms: Date.now() - capT0,
      sourceBytes: srcBuf.length,
      targetBytes: tgtBuf.length,
      screenshotsDir: path.relative(outRoot, shotsDir),
    });

    const runScreening = isScreeningEnabled({ skipScreening }) || screeningOnly;
    if (runScreening) {
      await dbg('screening_start', {});
      const screenT0 = Date.now();
      const screeningResult = await screenPair(
        sourceMetadata,
        targetMetadata,
        srcBuf,
        tgtBuf
      );
      report.screening = {
        verdict: screeningResult.verdict,
        skipAi: screeningResult.skipAi,
        scores: screeningResult.scores,
        reasons: screeningResult.reasons,
        failSignalCount: screeningResult.failSignalCount ?? null,
      };
      fs.writeFileSync(
        path.join(pairDir, 'screening.json'),
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            sourceUrl: source,
            targetUrl: target,
            ...screeningResult,
          },
          null,
          2
        )
      );
      await dbg('screening_done', {
        ms: Date.now() - screenT0,
        verdict: screeningResult.verdict,
        skipAi: screeningResult.skipAi,
        imageSimilarity: screeningResult.scores.imageSimilarity,
        textRecall: screeningResult.scores.textRecall,
        heightRatio: screeningResult.scores.heightRatio,
      });

      const deferTextAudit =
        getTextExpansionMode() === 'segment' &&
        isSegmentInteractionReplayEnabled() &&
        screeningResult.verdict !== 'fail' &&
        !screeningResult.skipAi;
      report.deferredTextAudit = deferTextAudit;

      if (screeningResult.verdict === 'fail') {
        report.textAudit = createSkippedTextAudit('skipped_screening_fail');
        await dbg('text_audit_skipped', {
          runReason: report.textAudit.runReason,
          screeningVerdict: screeningResult.verdict,
        });
        await writeTextAuditArtifact(
          pairDir,
          source,
          target,
          screeningResult.verdict,
          report.textAudit
        );
      } else if (deferTextAudit) {
        report.textAudit = createSkippedTextAudit('deferred_segment_interaction_replay');
        await dbg('text_audit_deferred', {
          runReason: report.textAudit.runReason,
          screeningVerdict: screeningResult.verdict,
        });
        await writeTextAuditArtifact(
          pairDir,
          source,
          target,
          screeningResult.verdict,
          report.textAudit
        );
      } else {
        await runPairTextAudit(
          report,
          sourceMetadata,
          targetMetadata,
          screeningResult.verdict,
          dbg
        );
        await writeTextAuditArtifact(
          pairDir,
          source,
          target,
          screeningResult.verdict,
          report.textAudit
        );
      }

      if (screeningResult.skipAi) {
        report.finishedReason =
          screeningResult.verdict === 'pass' ? 'screening_pass' : 'screening_fail';
        report.endedAt = new Date().toISOString();
        const reportPath = path.join(pairDir, 'pair-report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        await dbg('pair_end', {
          finishedReason: report.finishedReason,
          iterationCount: 0,
          missingCount: 0,
          screeningVerdict: screeningResult.verdict,
          pairReportRelative: path.relative(outRoot, reportPath),
        });
        return report;
      }

      if (screeningOnly) {
        report.finishedReason = 'screening_only';
        report.endedAt = new Date().toISOString();
        const reportPath = path.join(pairDir, 'pair-report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        await dbg('pair_end', {
          finishedReason: report.finishedReason,
          iterationCount: 0,
          missingCount: 0,
          screeningVerdict: screeningResult.verdict,
          pairReportRelative: path.relative(outRoot, reportPath),
        });
        return report;
      }
    } else {
      report.textAudit = createSkippedTextAudit('skipped_no_screening_data');
      fs.writeFileSync(
        path.join(pairDir, 'text-audit.json'),
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            sourceUrl: source,
            targetUrl: target,
            screeningVerdict: null,
            ...report.textAudit,
          },
          null,
          2
        )
      );
      await dbg('text_audit_skipped', {
        runReason: report.textAudit.runReason,
        screeningVerdict: null,
      });
    }
  } catch (e) {
    report.captureError = e.message;
    report.endedAt = new Date().toISOString();
    report.finishedReason = 'capture_failed';
    report.textAudit = createSkippedTextAudit('skipped_capture_failed');
    await dbg('capture_failed', {
      ms: Date.now() - capT0,
      error: e.message,
      stack: e.stack,
    });
    fs.writeFileSync(
      path.join(pairDir, 'text-audit.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          sourceUrl: source,
          targetUrl: target,
          screeningVerdict: null,
          ...report.textAudit,
        },
        null,
        2
      )
    );
    await dbg('text_audit_skipped', {
      runReason: report.textAudit.runReason,
      screeningVerdict: null,
    });
    return report;
  }

  const srcFullMeta = await sharp(srcBuf).metadata();
  const tgtFullMeta = await sharp(tgtBuf).metadata();
  const fullPageW = srcFullMeta.width || 1;
  const fullPageH = srcFullMeta.height || 1;
  const targetPageHeight = tgtFullMeta.height || fullPageH;
  let remainderTopPx = 0;
  const matchThresholds = loadMatchThresholds();

  for (let iter = 1; iter <= maxIterations; iter++) {
    await dbg('iteration_start', { iter, maxIterations });
    const preMeta = await sharp(sourceWorking).metadata();
    const preH = preMeta.height || 0;
    if (preH < minBlockHeight) {
      report.finishedReason = 'source_exhausted';
      await dbg('source_exhausted_before_segment', { iter, heightPx: preH });
      break;
    }
    const iterTag = String(iter).padStart(3, '0');
    let snap = Date.now();
    fs.writeFileSync(
      path.join(workByIter, `iter-${iterTag}-start-source.png`),
      sourceWorking
    );
    fs.writeFileSync(
      path.join(workByIter, `iter-${iterTag}-start-target.png`),
      targetWorking
    );
    await dbg('iteration_snapshots_start', { iter, ms: Date.now() - snap });

    let rl = Date.now();
    await rateLimiter.acquire();
    await dbg('rate_limit_wait', { iter, phase: 'segment', ms: Date.now() - rl });

    let img = Date.now();
    const segVision = await resizeForVision(sourceWorking, visionEdges.segmentMaxEdge);
    await dbg('resize_segment_source', {
      iter,
      ms: Date.now() - img,
      visionWidth: segVision.visionWidth,
      visionHeight: segVision.visionHeight,
      maxLongEdge: visionEdges.segmentMaxEdge,
    });

    const segmentParts = [
      { type: 'image_buffer', buffer: segVision.buffer },
      {
        type: 'text',
        text: `${segmentPromptForIteration(iter)}\n\n(Image dimensions for reference: ${segVision.visionWidth}x${segVision.visionHeight})`,
      },
    ];
    const segT0 = Date.now();
    const segResult = await visionJson(segmentParts, 2048);
    const segSegMs = Date.now() - segT0;
    const seg = segResult.parsed;

    await dbg('segment_api_done', {
      iter,
      ms: segSegMs,
      visionWidth: segVision.visionWidth,
      visionHeight: segVision.visionHeight,
      parsed: Boolean(seg),
      done: seg?.done === true,
      label: seg?.label ?? null,
    });

    if (!seg) {
      report.finishedReason = 'segment_parse_failed';
      report.segmentRawResponse = segResult.rawText?.slice(0, 2000) || null;
      await dbg('segment_parse_failed', {
        iter,
        ms: segSegMs,
        rawTextPreview: segResult.rawText?.slice(0, 2500) || null,
      });
      break;
    }

    if (seg.done === true) {
      report.finishedReason = 'segment_done';
      await dbg('segment_done_signal', { iter, ms: segSegMs });
      break;
    }

    const metaS = await sharp(sourceWorking).metadata();
    const fullW = metaS.width;
    const fullH = metaS.height;

    const segmentPromptText = `${segmentPromptForIteration(iter)}\n\n(Image dimensions for reference: ${segVision.visionWidth}x${segVision.visionHeight})`;
    let segToUse = await expandCardRowSegmentLoop({
      seg,
      segVision,
      iter,
      remainderHeightPx: fullH,
      segmentPromptText,
      rateLimiter,
      visionJsonFn: visionJson,
      dbg,
    });

    const bbox = segToUse.bbox;
    if (
      !bbox ||
      typeof bbox.x !== 'number' ||
      typeof bbox.y !== 'number' ||
      typeof bbox.width !== 'number' ||
      typeof bbox.height !== 'number'
    ) {
      report.finishedReason = 'invalid_segment_bbox';
      await dbg('invalid_segment_bbox', { iter, bbox });
      break;
    }

    let rectFull = normToPixelsFull(bbox, fullW, fullH);
    let segLabel = segToUse.label || null;
    let mergedFromIters = null;

    const fragmentMerge = tryApplyCardFragmentMerge({
      iter,
      rectFull,
      label: segLabel,
      report,
      workByIter,
      remainderTopPx,
      minBlockHeight,
    });
    if (fragmentMerge) {
      sourceWorking = fragmentMerge.sourceWorking;
      rectFull = fragmentMerge.mergedRect;
      remainderTopPx = fragmentMerge.remainderTopPx;
      segLabel = fragmentMerge.label;
      mergedFromIters = fragmentMerge.mergedFromIters;
      if (fragmentMerge.revokedTargetMatch) {
        targetWorking = await applyTargetStitchRemovals(
          targetFull,
          report.targetMatchedRegions
        );
        await dbg('target_stitch_revoked_after_card_merge', {
          iter,
          revokedPrevIter: fragmentMerge.revokedPrevIter,
          remainingMatches: report.targetMatchedRegions.length,
        });
      }
      await dbg('segment_card_fragment_merged', {
        iter,
        mergedFromIters,
        mergedHeightPx: rectFull.height,
        prevIter: mergedFromIters[0],
        revokedTargetMatch: fragmentMerge.revokedTargetMatch,
      });
    }

    const beforeExtendH = rectFull.height;
    rectFull = extendIncompleteCardRowBbox(rectFull, fullH, segLabel);
    if (rectFull.height > beforeExtendH) {
      await dbg('segment_card_row_extended_down', {
        iter,
        beforePx: beforeExtendH,
        afterPx: rectFull.height,
        minRequiredPx: minCardRowHeightPx(),
      });
    }

    if (rectFull.width < minBlockWidth || rectFull.height < minBlockHeight) {
      report.iterations.push({
        iter,
        label: segToUse.label,
        skipped: true,
        reason: 'bbox_too_small',
        bbox: rectFull,
      });
      await dbg('segment_skipped_small_bbox', {
        iter,
        bboxNorm: bbox,
        rectPixels: rectFull,
      });
      remainderTopPx += rectFull.y + rectFull.height;
      let adv = Date.now();
      sourceWorking = await cropBelowRect(sourceWorking, rectFull);
      await dbg('crop_below_small_bbox', { iter, ms: Date.now() - adv });

      let wr = Date.now();
      fs.writeFileSync(
        path.join(workByIter, `iter-${iterTag}-end-source.png`),
        sourceWorking
      );
      fs.writeFileSync(
        path.join(workByIter, `iter-${iterTag}-end-target.png`),
        targetWorking
      );
      fs.writeFileSync(path.join(workDir, 'source-remainder.png'), sourceWorking);
      fs.writeFileSync(path.join(workDir, 'target-remainder.png'), targetWorking);
      await dbg('iteration_write_working_pngs', { iter, ms: Date.now() - wr });
      continue;
    }

    let cropT0 = Date.now();
    const cropBuf = await extractCrop(sourceWorking, rectFull);
    const cropPath = path.join(cropsDir, `iter-${String(iter).padStart(3, '0')}.png`);
    fs.writeFileSync(cropPath, cropBuf);
    await dbg('crop_extract_write', {
      iter,
      ms: Date.now() - cropT0,
      cropRelative: path.relative(outRoot, cropPath),
      cropBytes: cropBuf.length,
      segmentRectPixels: rectFull,
    });

    const sourceBboxOnPage = {
      x: rectFull.x,
      y: remainderTopPx + rectFull.y,
      width: rectFull.width,
      height: rectFull.height,
    };

    rl = Date.now();
    await rateLimiter.acquire();
    await dbg('rate_limit_wait', { iter, phase: 'match', ms: Date.now() - rl });

    img = Date.now();
    const tgtVision = await resizeForVision(targetFull, visionEdges.matchTargetMaxEdge);
    const cropVision = await resizeForVision(cropBuf, visionEdges.matchCropMaxEdge);
    await dbg('resize_for_match', {
      iter,
      ms: Date.now() - img,
      targetWxH: `${tgtVision.visionWidth}x${tgtVision.visionHeight}`,
      cropWxH: `${cropVision.visionWidth}x${cropVision.visionHeight}`,
      maxLongEdgeTarget: visionEdges.matchTargetMaxEdge,
      maxLongEdgeCrop: visionEdges.matchCropMaxEdge,
    });

    const matchParts = [
      { type: 'image_buffer', buffer: cropVision.buffer },
      { type: 'image_buffer', buffer: tgtVision.buffer },
      {
        type: 'text',
        text: `${buildMatchPrompt(report.targetMatchedRegions, sourceBboxOnPage, fullPageW, fullPageH, targetPageHeight)}\n\nCrop image size: ${cropVision.visionWidth}x${cropVision.visionHeight}. Full target page: ${tgtVision.visionWidth}x${tgtVision.visionHeight}.`,
      },
    ];

    const matchT0 = Date.now();
    const matchResult = await visionJson(matchParts, 2048);
    const matchMs = Date.now() - matchT0;
    const match = matchResult.parsed;

    await dbg('match_api_done', {
      iter,
      ms: matchMs,
      cropVisionWxH: `${cropVision.visionWidth}x${cropVision.visionHeight}`,
      targetVisionWxH: `${tgtVision.visionWidth}x${tgtVision.visionHeight}`,
      parsed: Boolean(match),
      found: match?.found === true,
      confidence: match?.confidence ?? null,
    });

    if (!match) {
      await dbg('match_parse_missing', {
        iter,
        ms: matchMs,
        rawTextPreview: matchResult.rawText?.slice(0, 2500) || null,
      });
    }

    const metaT = await sharp(targetFull).metadata();
    const tw = metaT.width;
    const th = metaT.height;

    let targetRectFull = null;
    let targetBboxOnPage = null;
    let placement = null;
    let matchAcceptance = null;
    if (match && match.found === true && match.bbox) {
      targetRectFull = normToPixelsFull(match.bbox, tw, th);
      if (targetRectFull.width < minBlockWidth || targetRectFull.height < minBlockHeight) {
        targetRectFull = null;
      }
    }

    if (targetRectFull) {
      matchAcceptance = evaluateMatchAcceptance({
        match,
        sourceBboxOnPage,
        targetRectFull,
        sourcePageHeight: fullPageH,
        targetPageHeight,
        priorMatchedRegions: report.targetMatchedRegions,
        thresholds: matchThresholds,
      });
      if (matchAcceptance.accepted) {
        targetBboxOnPage = { ...targetRectFull };
        placement = matchAcceptance.placement;
      } else {
        await dbg('match_rejected', {
          iter,
          aiFound: matchAcceptance.aiFound,
          confidence: matchAcceptance.confidence,
          reasons: matchAcceptance.reasons,
          placement: matchAcceptance.placement,
          relativeVerticalDelta: matchAcceptance.relativeVerticalDelta,
          sourceMidRatio: matchAcceptance.sourceMidRatio,
          targetMidRatio: matchAcceptance.targetMidRatio,
          targetBboxPx: targetRectFull,
          sourceBboxOnPage,
        });
        targetRectFull = null;
      }
    } else if (match?.found === true) {
      matchAcceptance = {
        accepted: false,
        reasons: ['bbox_too_small'],
        aiFound: true,
        confidence: match.confidence ?? null,
        placement: null,
      };
    }

    const found = Boolean(targetRectFull && matchAcceptance?.accepted);

    let interaction = seg.interaction;
    if (
      isBlockInteractionManifestEnabled() &&
      (!interaction || interaction.expandable === undefined)
    ) {
      const cropAnalyzeT0 = Date.now();
      interaction = await analyzeCropInteraction(cropBuf, segLabel);
      await dbg('interaction_crop_analyze', {
        iter,
        ms: Date.now() - cropAnalyzeT0,
        expandable: interaction?.expandable === true,
        kind: interaction?.kind ?? null,
      });
    }

    const iterRecord = {
      iter,
      label: segLabel,
      segmentBbox: rectFull,
      sourceBboxOnPage,
      mergedFromIters,
      matchFound: found,
      targetBbox: found ? targetRectFull : null,
      targetBboxOnPage: found ? targetBboxOnPage : null,
      placement: found ? placement : null,
      cropPath: path.relative(outRoot, cropPath),
      confidence: match && typeof match.confidence === 'number' ? match.confidence : null,
      matchAiFound: match?.found === true,
      matchAccepted: found,
      matchRejectReasons: matchAcceptance?.reasons?.length ? matchAcceptance.reasons : null,
      matchRationale: match?.rationale ?? null,
      parseWarning: !match ? 'match_json_missing' : null,
      interaction: interaction || null,
    };

    if (interaction?.expandable === true) {
      const entry = manifestEntryFromSegment({
        iter,
        label: segLabel,
        segmentBboxPx: rectFull,
        remainderTopPx,
        fullPageWidth: fullPageW,
        fullPageHeight: fullPageH,
        interaction,
      });
      if (entry) {
        report.interactionManifest.regions.push(entry);
        iterRecord.interactionManifestEntry = entry;
      }
    }

    report.iterations.push(iterRecord);

    await dbg('iteration_decision', {
      iter,
      label: segLabel ?? null,
      matchFound: found,
      segmentBboxPx: rectFull,
      sourceBboxOnPage,
      targetBboxPx: found ? targetRectFull : null,
      placement,
      advancedSourceOnly: !found,
      advancedTargetStitch: found,
    });

    if (!found) {
      report.missing.push({
        iter,
        cropPath: iterRecord.cropPath,
        label: segLabel || null,
        sourceBbox: rectFull,
        sourceBboxOnPage,
      });
    } else {
      report.targetMatchedRegions.push({
        iter,
        label: segLabel || null,
        bbox: targetBboxOnPage,
        bboxNorm: pixelsToNormBbox(targetBboxOnPage, tw, th),
        placement,
        sourceBboxOnPage,
      });
      if (placement && placement !== 'aligned') {
        report.reorderedMatches.push({
          iter,
          label: segLabel || null,
          placement,
          sourceBboxOnPage,
          targetBboxOnPage,
        });
      }
      const stitchT0 = Date.now();
      const preStitchMeta = await sharp(targetWorking).metadata();
      targetWorking = await applyTargetStitchRemovals(
        targetFull,
        report.targetMatchedRegions
      );
      const postStitchMeta = await sharp(targetWorking).metadata();
      await dbg('target_stitch_removals', {
        iter,
        ms: Date.now() - stitchT0,
        matchedRegionCount: report.targetMatchedRegions.length,
        heightBefore: preStitchMeta.height,
        heightAfter: postStitchMeta.height,
      });
    }

    let targetCropPath = null;
    if (found && targetRectFull) {
      const targetCropT0 = Date.now();
      const targetCropBuf = await extractCrop(targetFull, targetRectFull);
      const targetCropFile = path.join(cropsDir, `iter-${iterTag}T.png`);
      fs.writeFileSync(targetCropFile, targetCropBuf);
      targetCropPath = path.relative(outRoot, targetCropFile);
      iterRecord.targetCropPath = targetCropPath;
      await dbg('target_crop_written', {
        iter,
        ms: Date.now() - targetCropT0,
        targetCropRelative: targetCropPath,
        targetCropBytes: targetCropBuf.length,
        targetRectPixels: targetRectFull,
      });
    }

    remainderTopPx += rectFull.y + rectFull.height;

    const cropBelowStart = Date.now();
    sourceWorking = await cropBelowRect(sourceWorking, rectFull);
    const cropBelowMs = Date.now() - cropBelowStart;
    await dbg('crop_below_remainder', {
      iter,
      sourceMs: cropBelowMs,
      targetStitched: found,
      targetUnchangedOnMiss: !found,
    });

    const endSnapStart = Date.now();
    fs.writeFileSync(
      path.join(workByIter, `iter-${iterTag}-end-source.png`),
      sourceWorking
    );
    fs.writeFileSync(
      path.join(workByIter, `iter-${iterTag}-end-target.png`),
      targetWorking
    );
    fs.writeFileSync(path.join(workDir, 'source-remainder.png'), sourceWorking);
    fs.writeFileSync(path.join(workDir, 'target-remainder.png'), targetWorking);
    await dbg('iteration_snapshots_end', { iter, ms: Date.now() - endSnapStart });
  }

  if (!report.finishedReason) {
    report.finishedReason = 'max_iterations';
  }

  fs.writeFileSync(
    path.join(pairDir, 'interaction-manifest.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        sourceUrl: source,
        targetUrl: target,
        fullPageWidth: fullPageW,
        fullPageHeight: fullPageH,
        ...report.interactionManifest,
      },
      null,
      2
    )
  );

  if (report.deferredTextAudit) {
    const screeningVerdict = report.screening?.verdict ?? null;
    if (report.interactionManifest.regions.length > 0) {
      await dbg('interaction_replay_start', {
        regionCount: report.interactionManifest.regions.length,
      });
      const replayT0 = Date.now();
      const [srcReplay, tgtReplay] = await Promise.all([
        replayInteractionManifestForText(source, report.interactionManifest, {
          ...resolvedCaptureOptions,
          captureRole: 'source',
          logCaptureStep: captureLog,
        }),
        replayInteractionManifestForText(target, report.interactionManifest, {
          ...resolvedCaptureOptions,
          captureRole: 'target',
          logCaptureStep: captureLog,
        }),
      ]);
      sourceMetadata = srcReplay.metadata;
      targetMetadata = tgtReplay.metadata;
      await dbg('interaction_replay_done', {
        ms: Date.now() - replayT0,
        sourceExpandedLines: sourceMetadata?.expandedVisibleText?.length ?? 0,
        targetExpandedLines: targetMetadata?.expandedVisibleText?.length ?? 0,
      });
    }
    await runPairTextAudit(report, sourceMetadata, targetMetadata, screeningVerdict, dbg);
    await writeTextAuditArtifact(pairDir, source, target, screeningVerdict, report.textAudit);
  }

  fs.writeFileSync(path.join(workDir, 'source-remainder.png'), sourceWorking);
  fs.writeFileSync(path.join(workDir, 'target-remainder.png'), targetWorking);
  fs.writeFileSync(path.join(shotsDir, 'target-full.png'), targetFull);

  if (report.targetMatchedRegions.length > 0 || report.missing.length > 0) {
    await dbg('extra_target_scan_start', {
      matchedRegionCount: report.targetMatchedRegions.length,
    });
    const extraT0 = Date.now();
    try {
      const extra = await scanExtraTargetBlocks(targetFull, report.targetMatchedRegions, {
        rateLimiter,
        matchTargetMaxEdge: visionEdges.matchTargetMaxEdge,
        minBlockWidth,
        minBlockHeight,
      });
      report.extraOnTarget = extra.blocks;
      if (extra.rawPreview) {
        report.extraOnTargetScanPreview = extra.rawPreview;
      }
      await dbg('extra_target_scan_done', {
        ms: Date.now() - extraT0,
        blockCount: extra.blocks.length,
      });
    } catch (e) {
      await dbg('extra_target_scan_error', { ms: Date.now() - extraT0, error: e.message });
      report.extraOnTargetScanError = e.message;
    }
  }

  report.endedAt = new Date().toISOString();

  const reportPath = path.join(pairDir, 'pair-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  await dbg('pair_end', {
    finishedReason: report.finishedReason,
    iterationCount: report.iterations.length,
    missingCount: report.missing.length,
    extraOnTargetCount: report.extraOnTarget.length,
    reorderedMatchCount: report.reorderedMatches.length,
    durationMsApprox:
      report.startedAt && report.endedAt
        ? new Date(report.endedAt) - new Date(report.startedAt)
        : null,
    pairReportRelative: path.relative(outRoot, reportPath),
  });

  return report;
}

module.exports = {
  processPair,
  slugForPair,
};
