#!/usr/bin/env node

/**
 * Page pair diff CLI — CSV of source,target URLs → screenshots + iterative AI segment/match.
 *
 * Loads .env from this package directory only (see lib/load-env.js).
 */

require('./lib/load-env').loadEnv();

const path = require('path');
const fs = require('fs');
const { finished } = require('stream/promises');
const { RateLimiter } = require('./lib/rate-limiter');
const { createRunLogger } = require('./lib/run-logger');
const { initializeClaudeClient, probeBedrockAuth } = require('./lib/claude');
const { processPair } = require('./lib/pair-worker');
const { loadRecipe, DEFAULT_RECIPE } = require('./lib/recipe');
const { createCacheStore, isCacheEnabled } = require('./lib/cache-store');

function screeningSummaryFields(report) {
  const s = report.screening;
  const scores = s?.scores || {};
  return {
    screeningVerdict: s?.verdict ?? null,
    skipAi: s?.skipAi ?? false,
    imageSimilarity: scores.imageSimilarity ?? null,
    textRecall: scores.textRecall ?? null,
    textJaccard: scores.textJaccard ?? null,
    heightRatio: scores.heightRatio ?? null,
  };
}

function textAuditSummaryFields(report) {
  const t = report.textAudit;
  return {
    textAuditStatus: t?.status ?? null,
    textAuditRunReason: t?.runReason ?? null,
    textAuditMode: t?.auditMode ?? null,
    textCoverage: t?.coverage ?? null,
    textMissingCount: t?.missingLineCount ?? 0,
    textMatchedCount: t?.matchedLineCount ?? 0,
    textSourceLineCount: t?.sourceLineCount ?? 0,
    textTargetLineCount: t?.targetLineCount ?? 0,
    textSourceBaselineLineCount: t?.sourceBaselineLineCount ?? null,
    textSourceLinesAddedByExpansion: t?.sourceLinesAddedByExpansion ?? null,
  };
}

function layoutAuditSummaryFields(report) {
  const l = report.layoutAudit;
  return {
    layoutStatus: l?.status ?? null,
    layoutMatchedCount: l?.matchedCount ?? null,
    layoutMissingCount: l?.missingCount ?? null,
    layoutExtraCount: l?.extraCount ?? null,
    layoutCoverage: l?.coverage ?? null,
    layoutDivergenceSegments: l?.divergenceSegmentCount ?? null,
    layoutDriftCount: l?.layoutDriftCount ?? null,
  };
}

function contentSummaryFields(report) {
  const c = report.contentComparison;
  const r = c?.rollup;
  return {
    aggregateScreeningVerdict: report.aggregateScreeningVerdict ?? null,
    contentProfiles: c?.profiles ? c.profiles.join('|') : null,
    contentMissingEntirelyCount: r?.missingEntirelyCount ?? 0,
    contentViewportShiftedCount: r?.viewportShiftedCount ?? 0,
  };
}

function parseArgs(argv) {
  const out = {
    csv: null,
    threads: 1,
    outDir: null,
    maxIterations: 40,
    help: false,
    probeBedrock: false,
    noScreening: false,
    screeningOnly: false,
    textOnly: false,
    recipe: null,
    cache: null, // null => env default; true/false => explicit --cache/--no-cache
    layoutAudit: null, // null => default on; false via --no-layout-audit
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--probe-bedrock') out.probeBedrock = true;
    else if (a === '--no-screening') out.noScreening = true;
    else if (a === '--screening-only') out.screeningOnly = true;
    else if (a === '--text-only') out.textOnly = true;
    else if (a.startsWith('--recipe=')) out.recipe = a.slice(9);
    else if (a === '--recipe') out.recipe = argv[++i];
    else if (a === '--cache') out.cache = true;
    else if (a === '--no-cache') out.cache = false;
    else if (a === '--layout-audit') out.layoutAudit = true;
    else if (a === '--no-layout-audit') out.layoutAudit = false;
    else if (a.startsWith('--csv=')) out.csv = a.slice(6);
    else if (a === '--csv') out.csv = argv[++i];
    else if (a.startsWith('--threads=')) out.threads = Math.max(1, parseInt(a.split('=')[1], 10) || 1);
    else if (a === '--threads') out.threads = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a.startsWith('--out=')) out.outDir = a.slice(6);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a.startsWith('--max-iterations=')) out.maxIterations = parseInt(a.split('=')[1], 10) || 40;
    else if (a === '--max-iterations') out.maxIterations = parseInt(argv[++i], 10) || 40;
  }
  return out;
}

function parseCsvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  let start = 0;
  if (lines.length && /^source\s*,\s*target/i.test(lines[0])) start = 1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const comma = line.indexOf(',');
    if (comma <= 0) continue;
    const source = line.slice(0, comma).trim().replace(/^"|"$/g, '');
    const target = line.slice(comma + 1).trim().replace(/^"|"$/g, '');
    if (source && target) rows.push({ source, target });
  }
  return rows;
}

function csvEscape(s) {
  const t = String(s ?? '');
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }

  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function printHelp() {
  console.log(`
Usage: node index.js --csv <pairs.csv> [--out <dir>] [--threads N] [--max-iterations N] [--recipe <file>]

CSV format (header optional):
  source,target
  https://example.com/original,https://example.com/migrated

Optional per-site recipe (YAML) — see recipe.example.yaml and ROADMAP.md:
  --recipe <file>          Load ignore/mask/normalize rules, capture profiles, interaction
                             hints. Omitted => zero-config defaults (desktop profile only).

Vision result cache (content-addressed by prompt + image bytes; reuses segment/match
results for identical inputs across pages and re-runs):
  --cache / --no-cache     Enable/disable (default off; PPD_CACHE=1 also enables)
  PPD_CACHE_DIR            Cache location (default ./.ppd-cache)

Text-layout audit (deterministic, AI-free): fingerprints each page's text geometry and
aligns source vs target -> localized missing/extra copy + CSS-drift signal.
  --layout-audit / --no-layout-audit   Enable/disable (default on; PPD_LAYOUT_AUDIT=0 disables)
  Artifacts: pairs/<slug>/layout-audit.json, run-level layout-missing.csv

Environment: copy .env.example to .env in this package directory.
  Only that folder is loaded — not parent repo .env files.

  AWS_BEARER_TOKEN_BEDROCK   Bedrock API key — fetch POST …/converse + Bearer header
  AWS_REGION                 Bedrock region (default us-east-2)
  ANTHROPIC_MODEL            Bedrock model / inference profile id
  CLAUDE_CODE_USE_BEDROCK=1  Without bearer: Bedrock via AWS SDK InvokeModel (IAM)
  ANTHROPIC_API_KEY          Direct Anthropic API (when not using Bedrock)

  --probe-bedrock            One Converse call; exits 0 if auth works

Verbose diagnostics (API timings, bbox, truncated raw responses) are appended only to
  <out>/run-debug.log (JSON Lines). Stdout stays minimal so logs are not pulled into AI chats.
  Events include per-phase capture timings (browser_launch, goto, reload, overlay_* , scroll_lazy_load,
  screenshot_full_page), overlay-dismiss rounds (vision_detect, round_match_vision, round_close_vision),
  and per-iteration steps (rate_limit_wait, resize_segment_source, segment_api_done, resize_for_match,
  match_api_done, crop_below_remainder, etc.).

Capture: optional cookie/modal dismissal via vision + DOM (lib/overlay-dismiss.js).
  PPD_DISMISS_OVERLAYS=0   Skip overlay dismissal (faster, fewer tokens)
  PPD_OVERLAY_LAZY_MS      Wait after reload before dismiss (default 4000)
  PPD_OVERLAY_DISMISS_MAX  Max overlays to process per URL (default 8)
  PPD_GOTO_WAIT_UNTIL           Playwright primary goto waitUntil (default load). Use networkidle only if needed;
                                  noisy sites rarely reach idle (60s+ waste). domcontentloaded is fastest.
  PPD_GOTO_NETWORKIDLE_TIMEOUT_MS  When waitUntil is networkidle, cap primary attempt (default 12000) before fallback.

Vision API image size (longest edge in px; smaller → faster/cheaper per segment/match call, may hurt bbox accuracy):
  PPD_VISION_MAX_LONG_EDGE      Applies to segment + match-target resize when specifics unset (default 1568)
  PPD_SEGMENT_VISION_MAX_EDGE   Segment step only (overrides shared default for segment)
  PPD_MATCH_TARGET_MAX_EDGE     Match step: target remainder image (overrides shared default)
  PPD_MATCH_CROP_MAX_EDGE       Match step: source crop (default 800)

USE_ANTHROPIC_API is not read; set ANTHROPIC_API_KEY and leave AWS_BEARER_TOKEN_BEDROCK empty for direct API.

Local pre-AI screening (after capture, before segment/match):
  --no-screening           Force AI for every pair (debug/regression)
  --screening-only         Capture + screening only; no Bedrock / no AI loop
  --text-only              Capture + text audit only; no image screening, no Bedrock / no AI loop
                             (writes text-audit.json + text-missing.csv; finishedReason "text_only")

  PPD_SCREENING=0          Disable screening (same as --no-screening)
  PPD_SCREEN_PASS_IMAGE_MIN          Min image similarity for pass (default 0.94)
  PPD_SCREEN_PASS_TEXT_RECALL_MIN    Min source-line recall for pass (default 0.96)
  PPD_SCREEN_PASS_HEIGHT_MIN/MAX     Height ratio band for pass (default 0.85 / 1.15)
  PPD_SCREEN_FAIL_IMAGE_MAX          Extreme low image for fail signal (default 0.35)
  PPD_SCREEN_FAIL_TEXT_RECALL_MAX    Extreme low text recall (default 0.25)
  PPD_SCREEN_FAIL_HEIGHT_MIN/MAX     Extreme height mismatch (default 0.5 / 2.0)
  PPD_SCREEN_FAIL_SIGNALS_REQUIRED   Fail signals needed to skip AI (default 2)
  PPD_SCREEN_FAIL_REQUIRE_ALL=1      Require all 3 fail signals for fail verdict
  PPD_SCREEN_PASS_SKIP_AI=1          Skip segment/match on screening pass (legacy cost saver)
  PPD_SCREEN_COMPARE_WIDTH           Downscale width for pixelmatch (default 512)

See SCREENING.md in this directory for tuning workflow.

Text audit expansion (symmetric UI clicks before text extract; used for text audit, not screening):
  PPD_TEXT_EXPANSION=0          Disable expansion (audit uses visible snapshot only)
  PPD_TEXT_EXPANSION_MAX_ACTIVATIONS   Max clicks total per page (default 30)
  PPD_TEXT_EXPANSION_MAX_NEXT_CLICKS   Max repeated next/slide clicks per control (default 12)
  PPD_TEXT_EXPANSION_SETTLE_MS         Wait after each click in ms (default 300)
  PPD_TEXT_EXPANSION_SCOPE             main | body (default main — only click inside main landmark)
  PPD_DEBUG_TEXT_PROBE                 Optional substring probe; adds textExpansion.debug to artifacts

Text match strictness (source line -> target, after exact + contiguous-substring):
  PPD_TEXT_MATCH_MIN_COVERAGE          Min contiguous source-token coverage for a partial match (default 0.8)
  PPD_TEXT_MATCH_MIN_TOKENS            Min source tokens before partial coverage applies (default 4)

Block match strictness (before target stitch):
  PPD_MATCH_MIN_CONFIDENCE             Min confidence to accept (default 0.85)
  PPD_MATCH_MIN_CONFIDENCE_REORDERED   Min confidence if vertically misaligned (default 0.9)
  PPD_MATCH_MAX_RELATIVE_VERTICAL_DELTA  Max |source%-target%| midline (default 0.14)
  PPD_MATCH_MAX_HEIGHT_RATIO_SKEW      Max |log(targetH/sourceH)| (default 0.75)
  PPD_MATCH_MAX_IOU_WITH_PRIOR         Reject if bbox overlaps prior match (default 0.2)

Segment card-row guards:
  PPD_SEGMENT_MIN_CARD_ROW_HEIGHT_PX   Re-segment if card row shorter (default 620)
  PPD_SEGMENT_MAX_CARD_FRAGMENT_HEIGHT_PX  Merge link strip if shorter (default 280)
  PPD_SEGMENT_MAX_CARD_CONTINUATION_HEIGHT_PX  Max height for continuation strip merge (default 280)
  PPD_SEGMENT_CARD_ROW_MAX_EXTEND_PX     Max downward bbox extend on source (default 200)
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.probeBedrock) {
    try {
      const r = await probeBedrockAuth();
      if (r.ok) {
        console.log(`Bedrock OK: ${r.message}`);
        process.exit(0);
      }
      console.error(`Bedrock probe failed: ${r.message}`);
      if (r.hint) console.error(r.hint);
      process.exit(1);
    } catch (e) {
      console.error(e.message || e);
      process.exit(1);
    }
  }

  if (!args.csv) {
    printHelp();
    process.exit(1);
  }

  if (!fs.existsSync(args.csv)) {
    console.error(`CSV not found: ${args.csv}`);
    process.exit(1);
  }

  const rows = parseCsvFile(args.csv);
  if (rows.length === 0) {
    console.error('No rows in CSV');
    process.exit(1);
  }

  // Optional per-site recipe. No recipe => zero-config defaults (desktop only) =>
  // behavior unchanged.
  let recipe = DEFAULT_RECIPE;
  if (args.recipe) {
    if (!fs.existsSync(args.recipe)) {
      console.error(`Recipe not found: ${args.recipe}`);
      process.exit(1);
    }
    try {
      const loaded = loadRecipe(args.recipe);
      recipe = loaded.recipe;
      for (const w of loaded.warnings) console.warn(`Recipe warning: ${w}`);
      console.log(`Recipe: ${args.recipe} (profiles: ${recipe.profiles.join(', ')})`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }

  // Persistent vision-result cache. Off unless --cache or PPD_CACHE=1 => parity.
  const cacheEnabled = args.cache != null ? args.cache : isCacheEnabled();
  const cacheStore = createCacheStore({ namespace: 'vision', enabled: cacheEnabled });

  // Deterministic text-layout audit (AI-free). Default on; disable with
  // --no-layout-audit or PPD_LAYOUT_AUDIT=0.
  const layoutAuditEnabled =
    args.layoutAudit != null
      ? args.layoutAudit
      : !(process.env.PPD_LAYOUT_AUDIT === '0' || process.env.PPD_LAYOUT_AUDIT === 'false');

  const outDir =
    args.outDir ||
    path.join(process.cwd(), `page-pair-diff-run-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`);

  fs.mkdirSync(outDir, { recursive: true });

  const runLogger = createRunLogger(outDir);
  await runLogger.event(null, 'run_start', {
    csv: path.resolve(args.csv),
    pairCount: rows.length,
    threads: args.threads,
    maxIterations: args.maxIterations,
    screeningOnly: args.screeningOnly,
    textOnly: args.textOnly,
    noScreening: args.noScreening,
    recipePath: args.recipe || null,
    profiles: recipe.profiles,
    cacheEnabled,
    cacheDir: cacheEnabled ? cacheStore.dir : null,
    layoutAuditEnabled,
    cwd: process.cwd(),
  });

  if (!args.screeningOnly && !args.textOnly) {
    await initializeClaudeClient();
  }

  const rateLimiter = args.screeningOnly || args.textOnly
    ? null
    : new RateLimiter({
        minDelayBetweenRequests: parseInt(process.env.PPD_MIN_DELAY_MS || '500', 10),
        maxRequestsPerMinute: parseInt(process.env.PPD_MAX_RPM || '30', 10),
      });

  const summaryPath = path.join(outDir, 'summary.jsonl');
  const summaryStream = fs.createWriteStream(summaryPath, { flags: 'a' });

  console.log(`Output: ${outDir}`);
  console.log(`Debug log (not stdout): ${runLogger.path}`);
  console.log(`Pairs: ${rows.length}, threads: ${args.threads}`);
  if (args.screeningOnly) console.log('Mode: screening-only (no AI)');
  if (args.textOnly) console.log('Mode: text-only (text comparison, no image screening / no AI)');
  if (args.noScreening) console.log('Mode: screening disabled (--no-screening)');
  if (cacheEnabled) console.log(`Vision cache: on (${cacheStore.dir})`);
  if (layoutAuditEnabled) console.log('Layout audit: on (deterministic text-layout fingerprint, AI-free)');

  const results = await runPool(rows, args.threads, async (pair, index) => {
    console.log(`\n[${index + 1}/${rows.length}] ${pair.source} → ${pair.target}`);
    const report = await processPair(pair, index, outDir, {
      rateLimiter,
      maxIterations: args.maxIterations,
      runLogger,
      skipScreening: args.noScreening,
      screeningOnly: args.screeningOnly,
      textOnly: args.textOnly,
      profiles: recipe.profiles,
      cacheStore,
      layoutAudit: layoutAuditEnabled,
    });
    const line = JSON.stringify({
      slug: report.slug,
      index: report.index,
      sourceUrl: report.sourceUrl,
      targetUrl: report.targetUrl,
      finishedReason: report.finishedReason,
      captureError: report.captureError,
      missingCount: report.missing ? report.missing.length : 0,
      extraOnTargetCount: report.extraOnTarget ? report.extraOnTarget.length : 0,
      reorderedMatchCount: report.reorderedMatches ? report.reorderedMatches.length : 0,
      iterationCount: report.iterations ? report.iterations.length : 0,
      ...screeningSummaryFields(report),
      ...textAuditSummaryFields(report),
      ...contentSummaryFields(report),
      ...layoutAuditSummaryFields(report),
    });
    summaryStream.write(`${line}\n`);
    await runLogger.event(report.slug, 'pair_summary_line', {
      finishedReason: report.finishedReason,
      captureError: report.captureError,
      iterationCount: report.iterations?.length ?? 0,
      missingCount: report.missing?.length ?? 0,
    });
    if (report.captureError) {
      console.error(`  Capture failed: ${report.captureError}`);
    } else {
      const screen = screeningSummaryFields(report);
      const screenNote =
        screen.screeningVerdict != null
          ? `, screening: ${screen.screeningVerdict}${screen.skipAi ? ' (skip AI)' : ''}`
          : '';
      console.log(
        `  Done: ${report.finishedReason}, iterations: ${report.iterations?.length ?? 0}, missing: ${report.missing?.length ?? 0}, extra on target: ${report.extraOnTarget?.length ?? 0}, reordered: ${report.reorderedMatches?.length ?? 0}${screenNote}`
      );
    }
    return report;
  });

  summaryStream.end();
  await finished(summaryStream);

  await runLogger.event(null, 'run_finish', {
    pairCount: results.length,
    summaryJsonl: 'summary.jsonl',
    summaryJson: 'summary.json',
    screeningSummaryCsv: 'screening-summary.csv',
    missingCsv: 'missing.csv',
    textMissingCsv: 'text-missing.csv',
    contentMissingCsv: 'content-missing.csv',
    screeningByProfileCsv: 'screening-by-profile.csv',
    extraOnTargetCsv: 'extra-on-target.csv',
    reorderedMatchesCsv: 'reordered-matches.csv',
    cacheStats: cacheEnabled ? cacheStore.stats() : null,
  });
  await runLogger.flush();

  if (cacheEnabled) {
    const cs = cacheStore.stats();
    const total = cs.hits + cs.misses;
    const rate = total ? ((cs.hits / total) * 100).toFixed(1) : '0.0';
    console.log(
      `Vision cache: ${cs.hits} hits / ${cs.misses} misses (${rate}% hit rate), ${cs.writes} writes`
    );
  }

  const summaryJson = path.join(outDir, 'summary.json');
  fs.writeFileSync(
    summaryJson,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        csv: path.resolve(args.csv),
        threads: args.threads,
        maxIterations: args.maxIterations,
        pairCount: results.length,
        screeningOnly: args.screeningOnly,
        textOnly: args.textOnly,
        noScreening: args.noScreening,
        results: results.map((r) => ({
          slug: r.slug,
          sourceUrl: r.sourceUrl,
          targetUrl: r.targetUrl,
          finishedReason: r.finishedReason,
          captureError: r.captureError,
          missingCount: (r.missing && r.missing.length) || 0,
          extraOnTargetCount: (r.extraOnTarget && r.extraOnTarget.length) || 0,
          reorderedMatchCount: (r.reorderedMatches && r.reorderedMatches.length) || 0,
          iterationCount: (r.iterations && r.iterations.length) || 0,
          ...screeningSummaryFields(r),
          ...textAuditSummaryFields(r),
          ...contentSummaryFields(r),
          ...layoutAuditSummaryFields(r),
        })),
      },
      null,
      2
    )
  );

  console.log(`\nWrote ${summaryJson}`);

  const screeningCsvPath = path.join(outDir, 'screening-summary.csv');
  const screeningHeader =
    'slug,verdict,skipAi,imageSimilarity,textRecall,heightRatio,sourceUrl,targetUrl\n';
  const screeningBody = results
    .filter((r) => r.screening)
    .map((r) => {
      const s = screeningSummaryFields(r);
      return [
        csvEscape(r.slug),
        csvEscape(s.screeningVerdict),
        s.skipAi ? '1' : '0',
        s.imageSimilarity != null ? s.imageSimilarity : '',
        s.textRecall != null ? s.textRecall : '',
        s.heightRatio != null ? s.heightRatio : '',
        csvEscape(r.sourceUrl),
        csvEscape(r.targetUrl),
      ].join(',');
    })
    .join('\n');
  fs.writeFileSync(screeningCsvPath, screeningHeader + (screeningBody ? `${screeningBody}\n` : ''));
  console.log(`Wrote ${screeningCsvPath}`);

  const missingRows = [];
  for (const r of results) {
    if (!r.missing || r.captureError) continue;
    for (const m of r.missing) {
      missingRows.push({
        slug: r.slug,
        iter: m.iter,
        cropPath: path.join(outDir, m.cropPath),
        label: m.label || '',
        sourceUrl: r.sourceUrl,
        targetUrl: r.targetUrl,
      });
    }
  }
  const missingCsvPath = path.join(outDir, 'missing.csv');
  const header = 'slug,iter,cropPath,label,sourceUrl,targetUrl\n';
  const body = missingRows
    .map(
      (row) =>
        `${csvEscape(row.slug)},${row.iter},${csvEscape(row.cropPath)},${csvEscape(row.label)},${csvEscape(row.sourceUrl)},${csvEscape(row.targetUrl)}`
    )
    .join('\n');
  fs.writeFileSync(missingCsvPath, header + (body ? `${body}\n` : ''));
  console.log(`Wrote ${missingCsvPath} (${missingRows.length} rows)`);

  const extraRows = [];
  const reorderedRows = [];
  for (const r of results) {
    if (r.captureError) continue;
    for (const b of r.extraOnTarget || []) {
      extraRows.push({
        slug: r.slug,
        label: b.label || '',
        bboxY: b.bbox?.y ?? '',
        bboxHeight: b.bbox?.height ?? '',
        sourceUrl: r.sourceUrl,
        targetUrl: r.targetUrl,
      });
    }
    for (const m of r.reorderedMatches || []) {
      reorderedRows.push({
        slug: r.slug,
        iter: m.iter,
        placement: m.placement || '',
        label: m.label || '',
        sourceUrl: r.sourceUrl,
        targetUrl: r.targetUrl,
      });
    }
  }
  const extraCsvPath = path.join(outDir, 'extra-on-target.csv');
  const extraHeader = 'slug,label,bboxY,bboxHeight,sourceUrl,targetUrl\n';
  const extraBody = extraRows
    .map(
      (row) =>
        `${csvEscape(row.slug)},${csvEscape(row.label)},${row.bboxY},${row.bboxHeight},${csvEscape(row.sourceUrl)},${csvEscape(row.targetUrl)}`
    )
    .join('\n');
  fs.writeFileSync(extraCsvPath, extraHeader + (extraBody ? `${extraBody}\n` : ''));
  console.log(`Wrote ${extraCsvPath} (${extraRows.length} rows)`);

  const reorderedCsvPath = path.join(outDir, 'reordered-matches.csv');
  const reorderedHeader = 'slug,iter,placement,label,sourceUrl,targetUrl\n';
  const reorderedBody = reorderedRows
    .map(
      (row) =>
        `${csvEscape(row.slug)},${row.iter},${csvEscape(row.placement)},${csvEscape(row.label)},${csvEscape(row.sourceUrl)},${csvEscape(row.targetUrl)}`
    )
    .join('\n');
  fs.writeFileSync(reorderedCsvPath, reorderedHeader + (reorderedBody ? `${reorderedBody}\n` : ''));
  console.log(`Wrote ${reorderedCsvPath} (${reorderedRows.length} rows)`);

  const textMissingRows = [];
  for (const r of results) {
    const textAudit = r.textAudit;
    if (!textAudit || textAudit.status !== 'discrepancies') continue;
    for (const line of textAudit.missingLines || []) {
      textMissingRows.push({
        slug: r.slug,
        sourceUrl: r.sourceUrl,
        targetUrl: r.targetUrl,
        screeningVerdict: r.screening?.verdict || '',
        finishedReason: r.finishedReason,
        lineIndex: line.lineIndex,
        sourceLine: line.sourceLine || '',
      });
    }
  }
  const textMissingCsvPath = path.join(outDir, 'text-missing.csv');
  const textMissingHeader =
    'slug,sourceUrl,targetUrl,screeningVerdict,finishedReason,lineIndex,sourceLine\n';
  const textMissingBody = textMissingRows
    .map(
      (row) =>
        `${csvEscape(row.slug)},${csvEscape(row.sourceUrl)},${csvEscape(row.targetUrl)},${csvEscape(row.screeningVerdict)},${csvEscape(row.finishedReason)},${row.lineIndex},${csvEscape(row.sourceLine)}`
    )
    .join('\n');
  fs.writeFileSync(
    textMissingCsvPath,
    textMissingHeader + (textMissingBody ? `${textMissingBody}\n` : '')
  );
  console.log(`Wrote ${textMissingCsvPath} (${textMissingRows.length} rows)`);

  // Content rollup: missing source copy split into missing-entirely (dropped
  // from the target under every profile) vs viewport-shifted (present under a
  // different profile). This is the reviewer-facing per-profile content result.
  const contentRows = [];
  for (const r of results) {
    const rollup = r.contentComparison?.rollup;
    if (!rollup || r.captureError) continue;
    for (const m of rollup.missingEntirely || []) {
      contentRows.push({
        slug: r.slug,
        classification: 'missing_entirely',
        missingUnderProfile: m.missingUnderProfile || '',
        sourceLine: m.sourceLine || '',
        sourceUrl: r.sourceUrl,
        targetUrl: r.targetUrl,
      });
    }
    for (const m of rollup.viewportShifted || []) {
      contentRows.push({
        slug: r.slug,
        classification: 'viewport_shifted',
        missingUnderProfile: m.missingUnderProfile || '',
        sourceLine: m.sourceLine || '',
        sourceUrl: r.sourceUrl,
        targetUrl: r.targetUrl,
      });
    }
  }
  const contentMissingCsvPath = path.join(outDir, 'content-missing.csv');
  const contentMissingHeader =
    'slug,classification,missingUnderProfile,sourceLine,sourceUrl,targetUrl\n';
  const contentMissingBody = contentRows
    .map(
      (row) =>
        `${csvEscape(row.slug)},${csvEscape(row.classification)},${csvEscape(row.missingUnderProfile)},${csvEscape(row.sourceLine)},${csvEscape(row.sourceUrl)},${csvEscape(row.targetUrl)}`
    )
    .join('\n');
  fs.writeFileSync(
    contentMissingCsvPath,
    contentMissingHeader + (contentMissingBody ? `${contentMissingBody}\n` : '')
  );
  const entirelyCount = contentRows.filter((c) => c.classification === 'missing_entirely').length;
  console.log(
    `Wrote ${contentMissingCsvPath} (${contentRows.length} rows: ${entirelyCount} missing-entirely, ${contentRows.length - entirelyCount} viewport-shifted)`
  );

  // Per-profile screening verdicts (one row per pair per profile).
  const screenProfileRows = [];
  for (const r of results) {
    if (!r.screeningByProfile || r.captureError) continue;
    for (const [profile, s] of Object.entries(r.screeningByProfile)) {
      screenProfileRows.push({
        slug: r.slug,
        profile,
        verdict: s.verdict,
        imageSimilarity: s.scores?.imageSimilarity ?? '',
        textRecall: s.scores?.textRecall ?? '',
        heightRatio: s.scores?.heightRatio ?? '',
        aggregateVerdict: r.aggregateScreeningVerdict || '',
        sourceUrl: r.sourceUrl,
        targetUrl: r.targetUrl,
      });
    }
  }
  const screenProfileCsvPath = path.join(outDir, 'screening-by-profile.csv');
  const screenProfileHeader =
    'slug,profile,verdict,imageSimilarity,textRecall,heightRatio,aggregateVerdict,sourceUrl,targetUrl\n';
  const screenProfileBody = screenProfileRows
    .map(
      (row) =>
        `${csvEscape(row.slug)},${csvEscape(row.profile)},${csvEscape(row.verdict)},${row.imageSimilarity},${row.textRecall},${row.heightRatio},${csvEscape(row.aggregateVerdict)},${csvEscape(row.sourceUrl)},${csvEscape(row.targetUrl)}`
    )
    .join('\n');
  fs.writeFileSync(
    screenProfileCsvPath,
    screenProfileHeader + (screenProfileBody ? `${screenProfileBody}\n` : '')
  );
  console.log(`Wrote ${screenProfileCsvPath} (${screenProfileRows.length} rows)`);

  // Text-layout audit: missing source copy localized by y (deterministic, AI-free).
  const layoutRows = [];
  for (const r of results) {
    const la = r.layoutAudit;
    if (!la || r.captureError) continue;
    for (const m of la.missing || []) {
      layoutRows.push({
        slug: r.slug,
        sourceY: m.y,
        sourceX: m.x,
        text: m.text || '',
        sourceUrl: r.sourceUrl,
        targetUrl: r.targetUrl,
      });
    }
  }
  const layoutMissingCsvPath = path.join(outDir, 'layout-missing.csv');
  const layoutMissingHeader = 'slug,sourceY,sourceX,text,sourceUrl,targetUrl\n';
  const layoutMissingBody = layoutRows
    .map(
      (row) =>
        `${csvEscape(row.slug)},${row.sourceY},${row.sourceX},${csvEscape(row.text)},${csvEscape(row.sourceUrl)},${csvEscape(row.targetUrl)}`
    )
    .join('\n');
  fs.writeFileSync(
    layoutMissingCsvPath,
    layoutMissingHeader + (layoutMissingBody ? `${layoutMissingBody}\n` : '')
  );
  console.log(`Wrote ${layoutMissingCsvPath} (${layoutRows.length} rows)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
