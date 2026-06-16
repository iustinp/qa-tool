/**
 * Compare visible text line sets (source vs target) for local screening.
 */

const { normalizeTextLine } = require('./visible-text');

/**
 * @param {string[]} linesA
 * @param {string[]} linesB
 * @returns {{ recall: number, jaccard: number, matchedLineCount: number, sourceLineCount: number, targetLineCount: number }}
 */
function compareTextLines(linesA, linesB) {
  const sourceLineCount = linesA.length;
  const targetLineCount = linesB.length;

  if (sourceLineCount === 0 && targetLineCount === 0) {
    return {
      recall: 1,
      jaccard: 1,
      matchedLineCount: 0,
      sourceLineCount: 0,
      targetLineCount: 0,
    };
  }

  if (sourceLineCount === 0) {
    return {
      recall: 1,
      jaccard: 0,
      matchedLineCount: 0,
      sourceLineCount: 0,
      targetLineCount,
    };
  }

  const setB = new Set(linesB.map((l) => normalizeTextLine(l)).filter(Boolean));
  let matchedLineCount = 0;
  for (const line of linesA) {
    const n = normalizeTextLine(line);
    if (n && setB.has(n)) matchedLineCount += 1;
  }

  const recall = matchedLineCount / sourceLineCount;

  const setA = new Set(linesA.map((l) => normalizeTextLine(l)).filter(Boolean));
  let intersection = 0;
  for (const line of setA) {
    if (setB.has(line)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union === 0 ? 0 : intersection / union;

  return {
    recall,
    jaccard,
    matchedLineCount,
    sourceLineCount,
    targetLineCount,
  };
}

module.exports = {
  compareTextLines,
};
