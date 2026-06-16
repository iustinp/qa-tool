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
  return {
    exactSet,
    substringBlob: ` ${substringLines.join(' ')} `,
  };
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
    },
    missingLines: [],
    lineResults: [],
  };
}

function auditVisibleText(sourceLines, targetLines, opts = {}) {
  const minSubstringLength = opts.minSubstringLength ?? 8;
  const source = Array.isArray(sourceLines) ? sourceLines : [];
  const target = Array.isArray(targetLines) ? targetLines : [];
  const sourceBaselineSet = new Set(
    (opts.sourceBaselineLines || []).map((l) => normalizeTextLine(l)).filter(Boolean)
  );

  const { exactSet, substringBlob } = buildTargetIndexes(target);
  const lineResults = [];
  const missingLines = [];
  const matchedBy = { exact: 0, substring: 0 };
  let matchedLineCount = 0;

  for (let i = 0; i < source.length; i++) {
    const originalLine = source[i] == null ? '' : String(source[i]);
    const normalizedLine = normalizeTextLine(originalLine);
    const normalizedSubstring = normalizeForSubstring(normalizedLine);

    let matchType = 'missing';
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
    }

    const entry = {
      lineIndex: i,
      sourceLine: originalLine,
      normalizedLine,
      matchType,
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
};
