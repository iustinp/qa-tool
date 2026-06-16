/**
 * Re-open a URL and apply a saved interaction manifest (segment-derived).
 */

const { captureFullPageBuffer } = require('./capture');
const { applyInteractionRegions } = require('./block-interaction');

/**
 * Navigate to url and apply manifest regions; return text metadata for audit.
 * @param {string} url
 * @param {{ regions: object[] }} manifest
 * @param {object} [captureOptions]
 */
async function replayInteractionManifestForText(url, manifest, captureOptions = {}) {
  const regions = manifest?.regions || [];

  const cap = await captureFullPageBuffer(url, {
    ...captureOptions,
    collectMetadata: true,
    textExpansion: false,
    onPageReady:
      regions.length > 0
        ? async (page) => {
            const expanded = await applyInteractionRegions(page, regions, {
              extractOpts: captureOptions.extractOpts,
            });
            return { expanded };
          }
        : undefined,
  });

  if (!regions.length) {
    const baseline = cap.metadata?.visibleText || [];
    return {
      metadata: {
        ...cap.metadata,
        expandedVisibleText: baseline,
        expandedVisibleTextCharCount: cap.metadata?.visibleTextCharCount ?? 0,
        textExpansion: { enabled: false, mode: 'segment', activations: 0, regionCount: 0 },
      },
    };
  }

  const expanded = cap.onPageReadyResult?.expanded;
  if (!expanded) {
    throw new Error('interaction_replay_missing_expanded_result');
  }

  return {
    metadata: {
      pageWidth: cap.metadata?.pageWidth,
      pageHeight: cap.metadata?.pageHeight,
      title: cap.metadata?.title,
      visibleText: expanded.visibleText,
      visibleTextCharCount: expanded.visibleTextCharCount,
      expandedVisibleText: expanded.expandedVisibleText,
      expandedVisibleTextCharCount: expanded.expandedVisibleTextCharCount,
      textExpansion: { ...expanded.expansion, mode: 'segment' },
    },
  };
}

module.exports = {
  replayInteractionManifestForText,
};
