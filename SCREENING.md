# Local pair screening

Pre-AI triage runs **after** full-page capture for each source/target pair. It compares:

- **Image similarity** — downscaled PNGs via `sharp` + `pixelmatch`
- **DOM visible text** — normalized line recall (source lines found in target)
- **Page height ratio** — `source.pageHeight / target.pageHeight` from capture metadata

No Bedrock calls are made during screening.

## Verdicts

| Verdict | Meaning | AI loop |
|---------|---------|---------|
| `pass` | Clearly the same page (all pass thresholds met) | **Runs** (default; text/block checks need segment path) |
| `fail` | Clearly different (enough extreme fail signals) | **Skipped** |
| `needs_ai` | Gray zone | **Runs** (unless `--screening-only`) |

To restore the old behavior (skip Bedrock on `pass` for cost savings): `PPD_SCREEN_PASS_SKIP_AI=1`.

### Pass (all required)

- `imageSimilarity >= PPD_SCREEN_PASS_IMAGE_MIN` (default **0.94**)
- `textRecall >= PPD_SCREEN_PASS_TEXT_RECALL_MIN` (default **0.96**)
- `heightRatio` in `[PPD_SCREEN_PASS_HEIGHT_MIN, PPD_SCREEN_PASS_HEIGHT_MAX]` (default **0.85–1.15**)

### Fail (extreme only)

At least **2** of these (configurable), unless `PPD_SCREEN_FAIL_REQUIRE_ALL=1`:

- `imageSimilarity < PPD_SCREEN_FAIL_IMAGE_MAX` (default **0.35**)
- `textRecall < PPD_SCREEN_FAIL_TEXT_RECALL_MAX` (default **0.25**)
- `heightRatio` outside **0.5–2.0** (or height ratio 0 when dimensions missing)

Otherwise → `needs_ai`.

## CLI

```bash
# Tune thresholds without AI
node index.js --csv pairs.csv --out ./screen-tune --screening-only --threads 1

# Full run with screening (default on)
node index.js --csv pairs.csv --out ./run-out

# Force AI for every pair
node index.js --csv pairs.csv --out ./run-out --no-screening
```

## Artifacts

Per pair:

- `pairs/<slug>/screening.json` — full scores, thresholds snapshot, reasons
- `pairs/<slug>/pair-report.json` — includes `screening` when run

Run level:

- `screening-summary.csv` — `slug,verdict,skipAi,imageSimilarity,textRecall,heightRatio,sourceUrl,targetUrl`
- `summary.jsonl` / `summary.json` — screening fields on each result

Debug: `run-debug.log` events `screening_start`, `screening_done`, `visible_text_extract`.

## Tuning workflow

1. Run `--screening-only` on a labeled sample CSV.
2. Open `screening-summary.csv` and spot-check `pass` / `fail` pairs (screenshots in `pairs/<slug>/screenshots/`).
3. Adjust env thresholds; re-run until false pass/fail rates are acceptable.
4. Full batch with screening enabled; compare `segment_api_done` count in `run-debug.log` vs a `--no-screening` baseline.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PPD_SCREENING` | `1` | Master enable (`0` / `false` disables) |
| `PPD_SCREEN_PASS_IMAGE_MIN` | `0.94` | Min similarity for pass |
| `PPD_SCREEN_PASS_TEXT_RECALL_MIN` | `0.96` | Min source-line recall for pass |
| `PPD_SCREEN_PASS_HEIGHT_MIN` | `0.85` | Pass height ratio lower bound |
| `PPD_SCREEN_PASS_HEIGHT_MAX` | `1.15` | Pass height ratio upper bound |
| `PPD_SCREEN_FAIL_IMAGE_MAX` | `0.35` | Extreme low image |
| `PPD_SCREEN_FAIL_TEXT_RECALL_MAX` | `0.25` | Extreme low text |
| `PPD_SCREEN_FAIL_HEIGHT_MIN` | `0.5` | Extreme height mismatch (low) |
| `PPD_SCREEN_FAIL_HEIGHT_MAX` | `2.0` | Extreme height mismatch (high) |
| `PPD_SCREEN_FAIL_SIGNALS_REQUIRED` | `2` | Fail signals needed for `fail` |
| `PPD_SCREEN_FAIL_REQUIRE_ALL` | — | Set `1` to require all 3 fail signals |
| `PPD_SCREEN_PASS_SKIP_AI` | off | Set `1` to skip segment/match on `pass` (legacy) |
| `PPD_SCREEN_COMPARE_WIDTH` | `512` | Downscale width for pixelmatch |
| `PPD_SCREEN_BANDS` | `8` | Horizontal bands for regional image diff (`0` disables) |
| `PPD_SCREEN_BAND_CHANGED_MAX` | `0.9` | A band counts as "changed" below this similarity |

## Regional (banded) image diff

Screening also splits the compared image into `PPD_SCREEN_BANDS` horizontal bands
and scores each, so we know **where** the pages differ, not just the overall
similarity. This is **additive** — the pass/fail/needs_ai verdict still uses the
global `imageSimilarity`. Per-band results (`imageBands`, `imageChangedBandCount`)
appear in `screening.json` `scores`. Bands seed a future optimization: only send
the changed regions to the AI (fewer/cheaper vision calls).

## Visible text extraction

By default, **`<img alt="...">` text is not included** in `visibleText` / text audit lines (reduces decorative/icon alt noise). To include alt text again:

```bash
PPD_INCLUDE_IMAGE_ALT=1
```

## Text audit expansion (optional, on by default)

Before text audit, capture can run a **symmetric expansion** pass on source and target: click generic tabs, accordions, and next/slide controls inside `main`, re-extract visible text after each click, and union lines. Text audit compares these expanded sets (screening still uses the baseline visible snapshot only).

Disable: `PPD_TEXT_EXPANSION=0`

Tune: `PPD_TEXT_EXPANSION_MAX_ACTIVATIONS`, `PPD_TEXT_EXPANSION_MAX_NEXT_CLICKS`, `PPD_TEXT_EXPANSION_SETTLE_MS`, `PPD_TEXT_EXPANSION_SCOPE=main|body`

Expansion clicks tabs, Bootstrap-style `.carousel-control` arrows, AEM slide indicators (`Show Slide N`), and generic next buttons — then unions newly visible text. Screening still uses the baseline visible snapshot only.

Optional troubleshooting: `PPD_DEBUG_TEXT_PROBE="substring"` adds `textExpansion.debug` with DOM probe + per-selector click stats.

Artifacts: `text-audit.json` includes `auditMode: "expanded"`, `sourceBaselineLineCount`, `sourceLinesAddedByExpansion`, and per-line `inBaseline` in `lineResults`.

## Block match strictness

Vision may propose a match; **programmatic gates** run before target stitch. Compares **relative** vertical position (% from top) so source/target pages of different height still match (e.g. footer).

Rejected when:

- `confidence` &lt; `PPD_MATCH_MIN_CONFIDENCE` (default **0.85**)
- Relative midline differs by more than **14%** of page height unless confidence ≥ **0.9**
- Target block height skew vs source exceeds `PPD_MATCH_MAX_HEIGHT_RATIO_SKEW` (unless aligned + high confidence)
- Bbox overlaps an already-matched target region

Card-row segments: expansion retry if too short; link-only fragments merge with previous card row (`segment-guards.js`).

See `matchRejectReasons` on each iteration in `pair-report.json`.

## Text match strictness (source line → target)

Each source line is matched against the target in three escalating stages so that
DOM-structure differences (common in migrations) don't cause false "missing":

1. **exact** — normalized source line equals a normalized target line.
2. **substring** — normalized source line (punctuation collapsed, ≥ 8 chars) appears
   as a contiguous run in the flattened target text.
3. **partial** — the longest contiguous run of source tokens found in the flattened
   target covers ≥ `PPD_TEXT_MATCH_MIN_COVERAGE` (default **0.8**) of the line's tokens
   (only for lines with ≥ `PPD_TEXT_MATCH_MIN_TOKENS` tokens, default **4**).

Stage 3 handles inline links merged into a sentence by `innerText` (e.g. source
`…do advance bookings online.` where the target splits `online` into its own node):
the sentence still matches at ~0.93 coverage, while a genuinely absent sentence whose
words are only scattered in the target stays below the threshold and is reported missing.
`matchType` and `tokenCoverage` appear per line in `text-audit.json` (`matchedBy.partial`
counts stage-3 matches).

## Limitations (v1)

- Line match is exact → contiguous-substring → contiguous-token-coverage (no Levenshtein/fuzzy word edits).
- Image compare is downscaled global similarity for the verdict, plus additive per-band regional scores (not yet used to gate vision).
- No OCR — image-heavy heroes may land in `needs_ai` (intended).
- Restyled pages with same copy may be `needs_ai` (intended).

## Sample tuning run

```bash
cd tools/page-pair-diff
npm install
node index.js --csv test-worldbank-pair.csv --out ./screen-tune --screening-only --threads 1
```

Review `./screen-tune/screening-summary.csv` and per-pair `screening.json`.

### Reference scores (`test-worldbank-pair.csv`, defaults)

Run on 2026-05-27 with default thresholds; both pairs correctly landed in `needs_ai` (migrated pages differ visually/copy-wise enough that pass bars were not met; fail bars were not extreme).

| Pair | verdict | imageSimilarity | textRecall | heightRatio |
|------|---------|-----------------|------------|-------------|
| Alliance Bernstein home | `needs_ai` | 0.745 | 0.737 | 1.044 |
| World Bank Academy home | `needs_ai` | 0.735 | 0.792 | 1.014 |

Reasons for both: `image_below_pass`, `text_below_pass` (height within pass band). Default pass thresholds (0.94 image, 0.96 text recall) are intentionally strict so real migration diffs route to AI; lower pass bars only after validating labeled same-page pairs.
