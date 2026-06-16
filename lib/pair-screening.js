/**
 * Local pre-AI screening: pass / fail / needs_ai from image + DOM text + page height.
 */

const { compareImages } = require('./image-similarity');
const { compareTextLines } = require('./text-similarity');

function envFloat(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * @returns {object}
 */
/**
 * When false (default), screening `pass` pairs still run the vision segment/match loop
 * so text expansion (segment replay) and block comparison are not skipped.
 */
function skipAiOnPassVerdict() {
  const v = process.env.PPD_SCREEN_PASS_SKIP_AI;
  return v === '1' || v === 'true';
}

function loadScreeningThresholds() {
  return {
    passImageMin: envFloat('PPD_SCREEN_PASS_IMAGE_MIN', 0.94),
    passTextRecallMin: envFloat('PPD_SCREEN_PASS_TEXT_RECALL_MIN', 0.96),
    passHeightMin: envFloat('PPD_SCREEN_PASS_HEIGHT_MIN', 0.85),
    passHeightMax: envFloat('PPD_SCREEN_PASS_HEIGHT_MAX', 1.15),
    failImageMax: envFloat('PPD_SCREEN_FAIL_IMAGE_MAX', 0.35),
    failTextRecallMax: envFloat('PPD_SCREEN_FAIL_TEXT_RECALL_MAX', 0.25),
    failHeightMin: envFloat('PPD_SCREEN_FAIL_HEIGHT_MIN', 0.5),
    failHeightMax: envFloat('PPD_SCREEN_FAIL_HEIGHT_MAX', 2.0),
    failSignalsRequired: envInt('PPD_SCREEN_FAIL_SIGNALS_REQUIRED', 2),
    failRequireAll: process.env.PPD_SCREEN_FAIL_REQUIRE_ALL === '1',
    compareWidth: envInt('PPD_SCREEN_COMPARE_WIDTH', 512),
  };
}

/**
 * @param {object} sourceMeta
 * @param {object} targetMeta
 * @param {Buffer} sourceBuffer
 * @param {Buffer} targetBuffer
 * @param {{ thresholds?: object }} [opts]
 * @returns {Promise<object>}
 */
async function screenPair(sourceMeta, targetMeta, sourceBuffer, targetBuffer, opts = {}) {
  const thresholds = opts.thresholds || loadScreeningThresholds();
  const reasons = [];

  const srcH = sourceMeta.pageHeight || 0;
  const tgtH = targetMeta.pageHeight || 0;
  const heightRatio =
    tgtH > 0 && srcH > 0 ? srcH / tgtH : srcH === tgtH ? 1 : 0;

  const textMetrics = compareTextLines(
    sourceMeta.visibleText || [],
    targetMeta.visibleText || []
  );

  const imageResult = await compareImages(sourceBuffer, targetBuffer, {
    compareWidth: thresholds.compareWidth,
  });

  const scores = {
    imageSimilarity: imageResult.similarity,
    imageDiffRatio: imageResult.diffRatio,
    textRecall: textMetrics.recall,
    textJaccard: textMetrics.jaccard,
    heightRatio,
    sourceLineCount: textMetrics.sourceLineCount,
    targetLineCount: textMetrics.targetLineCount,
    matchedLineCount: textMetrics.matchedLineCount,
    sourcePageHeight: srcH,
    targetPageHeight: tgtH,
    compareWidth: imageResult.compareWidth,
    compareHeight: imageResult.compareHeight,
    imageCompareMs: imageResult.ms,
  };

  const passHeightOk =
    heightRatio >= thresholds.passHeightMin && heightRatio <= thresholds.passHeightMax;
  const passImageOk = scores.imageSimilarity >= thresholds.passImageMin;
  const passTextOk = scores.textRecall >= thresholds.passTextRecallMin;

  if (passImageOk && passTextOk && passHeightOk) {
    const skipAi = skipAiOnPassVerdict();
    return {
      verdict: 'pass',
      skipAi,
      scores,
      thresholds,
      reasons: skipAi ? ['pass_all_signals', 'ai_skipped_by_env'] : ['pass_all_signals'],
    };
  }

  if (!passImageOk) reasons.push('image_below_pass');
  if (!passTextOk) reasons.push('text_below_pass');
  if (!passHeightOk) reasons.push('height_outside_pass_band');

  const lowImage = scores.imageSimilarity < thresholds.failImageMax;
  const lowText = scores.textRecall < thresholds.failTextRecallMax;
  const badHeight =
    heightRatio > 0 &&
    (heightRatio < thresholds.failHeightMin || heightRatio > thresholds.failHeightMax);

  const failSignals = [lowImage, lowText, badHeight].filter(Boolean);
  const failCount = failSignals.length;
  const required = thresholds.failRequireAll ? 3 : thresholds.failSignalsRequired;

  if (failCount >= required) {
    const failReasons = [];
    if (lowImage) failReasons.push('extreme_low_image');
    if (lowText) failReasons.push('extreme_low_text_recall');
    if (badHeight) failReasons.push('extreme_height_mismatch');
    return {
      verdict: 'fail',
      skipAi: true,
      scores,
      thresholds,
      reasons: failReasons,
      failSignalCount: failCount,
    };
  }

  return {
    verdict: 'needs_ai',
    skipAi: false,
    scores,
    thresholds,
    reasons: reasons.length ? reasons : ['gray_zone'],
    failSignalCount: failCount,
  };
}

function isScreeningEnabled(options = {}) {
  if (options.skipScreening === true) return false;
  const v = process.env.PPD_SCREENING;
  if (v === '0' || v === 'false') return false;
  return true;
}

module.exports = {
  screenPair,
  loadScreeningThresholds,
  isScreeningEnabled,
  skipAiOnPassVerdict,
};
