const { normalizeTextLine } = require('./visible-text');

function normalizeForSubstring(value) {
  return normalizeTextLine(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTargetIndexes(targetLines) {
  const exactSet = new Set();
  const substringLines = [];
  for (const line of targetLines || []) {
    const exact = normalizeTextLine(line);
    if (!exact) continue;
    exactSet.add(exact);
    const substring = normalizeForSubstring(exact);
    if (substring) substringLines.push(substring);
  }
  // Flatten the whole target page into one normalized token stream. Comparing
  // against this (rather than per-line) makes matching independent of how the
  // target DOM happens to segment text into nodes/lines.
  const substringBlob = ` ${substringLines.join(' ')} `;
  return {
    exactSet,
    substringBlob,
    tokenBlob: ` ${substringLines.join(' ')} `,
  };
}

/**
 * Longest run of consecutive source tokens that appears as a contiguous token
 * sequence anywhere in the target token blob, expressed as a fraction of the
 * source tokens. A whole-line match returns 1; an inline link that got merged
 * into the source sentence (e.g. "…bookings online" where the target splits
 * "online" into its own node) still yields near-1 coverage.
 * @param {string[]} sourceTokens
 * @param {string} tokenBlob normalized target blob, space-delimited with sentinel spaces
 * @returns {number}
 */
function longestContiguousTokenCoverage(sourceTokens, tokenBlob) {
  const n = sourceTokens.length;
  if (n === 0) return 0;
  let maxRun = 0;
  for (let i = 0; i < n; i++) {
    // Extend the window [i..j] while it stays a contiguous substring of the blob.
    let run = '';
    for (let j = i; j < n; j++) {
      run = run ? `${run} ${sourceTokens[j]}` : sourceTokens[j];
      if (tokenBlob.includes(` ${run} `)) {
        const len = j - i + 1;
        if (len > maxRun) maxRun = len;
      } else {
        break;
      }
    }
    if (maxRun === n) break;
  }
  return maxRun / n;
}

function createSkippedTextAudit(runReason) {
  return {
    status: 'skipped',
    runReason,
    sourceLineCount: 0,
    targetLineCount: 0,
    matchedLineCount: 0,
    missingLineCount: 0,
    coverage: null,
    matchedBy: {
      exact: 0,
      substring: 0,
      partial: 0,
    },
    missingLines: [],
    lineResults: [],
  };
}

function auditVisibleText(sourceLines, targetLines, opts = {}) {
  const minSubstringLength = opts.minSubstringLength ?? 8;
  // Partial (token-coverage) match: a source line whose tokens appear as a large
  // contiguous run in the target counts as present even if a merged inline link
  // or restructured DOM prevents a whole-line contiguous match.
  const minCoverage =
    opts.minTokenCoverage ??
    parseFloat(process.env.PPD_TEXT_MATCH_MIN_COVERAGE || '0.8');
  const minCoverageTokens =
    opts.minTokenCoverageTokens ??
    parseInt(process.env.PPD_TEXT_MATCH_MIN_TOKENS || '4', 10);
  const source = Array.isArray(sourceLines) ? sourceLines : [];
  const target = Array.isArray(targetLines) ? targetLines : [];
  const sourceBaselineSet = new Set(
    (opts.sourceBaselineLines || []).map((l) => normalizeTextLine(l)).filter(Boolean)
  );

  const { exactSet, substringBlob, tokenBlob } = buildTargetIndexes(target);
  const lineResults = [];
  const missingLines = [];
  const matchedBy = { exact: 0, substring: 0, partial: 0 };
  let matchedLineCount = 0;

  for (let i = 0; i < source.length; i++) {
    const originalLine = source[i] == null ? '' : String(source[i]);
    const normalizedLine = normalizeTextLine(originalLine);
    const normalizedSubstring = normalizeForSubstring(normalizedLine);
    const sourceTokens = normalizedSubstring ? normalizedSubstring.split(' ') : [];

    let matchType = 'missing';
    let coverage = null;
    if (normalizedLine && exactSet.has(normalizedLine)) {
      matchType = 'exact';
      matchedBy.exact += 1;
      matchedLineCount += 1;
    } else if (
      normalizedSubstring &&
      normalizedSubstring.length >= minSubstringLength &&
      substringBlob.includes(` ${normalizedSubstring} `)
    ) {
      matchType = 'substring';
      matchedBy.substring += 1;
      matchedLineCount += 1;
    } else if (sourceTokens.length >= minCoverageTokens) {
      coverage = longestContiguousTokenCoverage(sourceTokens, tokenBlob);
      if (coverage >= minCoverage) {
        matchType = 'partial';
        matchedBy.partial += 1;
        matchedLineCount += 1;
      }
    }

    const entry = {
      lineIndex: i,
      sourceLine: originalLine,
      normalizedLine,
      matchType,
      tokenCoverage: coverage,
      inBaseline: sourceBaselineSet.size > 0 ? sourceBaselineSet.has(normalizedLine) : null,
    };
    lineResults.push(entry);
    if (matchType === 'missing') {
      missingLines.push(entry);
    }
  }

  const sourceLineCount = source.length;
  const targetLineCount = target.length;
  const missingLineCount = missingLines.length;
  const coverage = sourceLineCount > 0 ? matchedLineCount / sourceLineCount : 1;

  const sourceBaselineLineCount = opts.sourceBaselineLines?.length ?? sourceLineCount;
  const targetBaselineLineCount = opts.targetBaselineLines?.length ?? targetLineCount;
  const sourceLinesAddedByExpansion = Math.max(0, sourceLineCount - sourceBaselineLineCount);

  return {
    status: missingLineCount === 0 ? 'ok' : 'discrepancies',
    runReason: 'eligible',
    auditMode: opts.auditMode || 'visible',
    sourceLineCount,
    targetLineCount,
    sourceBaselineLineCount,
    targetBaselineLineCount,
    sourceLinesAddedByExpansion,
    targetLinesAddedByExpansion: Math.max(0, targetLineCount - targetBaselineLineCount),
    sourceExpansion: opts.sourceExpansion || null,
    targetExpansion: opts.targetExpansion || null,
    matchedLineCount,
    missingLineCount,
    coverage,
    matchedBy,
    missingLines,
    lineResults,
  };
}

module.exports = {
  auditVisibleText,
  createSkippedTextAudit,
  normalizeForSubstring,
};
