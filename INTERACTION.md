# Vision-guided interaction expansion

CSS selectors (`.carousel-control`, `.swiper-button-next`, …) break when class names are arbitrary. This pipeline uses **vision + DOM geometry** instead: the model points at controls; Playwright resolves clicks inside the block region without relying on class names.

## Modes (`PPD_TEXT_EXPANSION_MODE`)

| Mode | When clicks run | Best for |
|------|-----------------|----------|
| `selectors` (default) | Capture | Legacy / fast heuristic pass |
| `vision` | Capture (full-page scan) | Pass + needs_ai without extra segment cost |
| `both` | Capture (vision then selectors) | Maximum recall (noisier) |
| `segment` | After segment loop + replay | Block-aligned manifest from the same AI walk |

Set `PPD_TEXT_EXPANSION=0` to disable all expansion (audit uses baseline visible text only).

## Architecture

```
Capture (browser open)
  ├─ screenshot + baseline visible text
  ├─ [vision mode] full-page vision → regions + control bboxes (0–1)
  └─ DOM: candidates in region → IoU match → click → union text

Segment loop (static PNGs, needs_ai)
  ├─ segment prompt (+ optional interaction JSON per block)
  ├─ crop-level vision fallback if block omitted interaction
  ├─ manifest: blockBbox + controls in **full-page** normalized coords
  └─ write interaction-manifest.json

[segment mode + PPD_SEGMENT_INTERACTION_REPLAY=1]
  ├─ re-open source + target
  ├─ replay manifest (same normalized bboxes on both pages)
  └─ text audit on expanded lines
```

### DOM mapping (class-name agnostic)

1. Vision returns `blockBbox` and `controls[].bbox` (normalized to the screenshot).
2. Convert to document pixels using `scrollWidth` / `scrollHeight`.
3. Collect `button`, `a`, `[role=button]`, `[role=tab]`, `summary` whose center lies in the control bbox (± padding).
4. Pick highest IoU with the vision box; click via DOM `.click()` or fall back to `elementFromPoint` at the vision center.

Coordinates are tied to the **full-page screenshot** taken after lazy-load scroll, so they align with document space, not viewport-only.

### Why segment + replay?

The browser closes after capture; the segment loop only sees PNGs. Block-level interaction metadata is accumulated during segmentation, then **replayed** in a second navigation so text audit can use expanded copy without keeping a session open for the whole match loop.

**Pass** pairs run the segment loop by default (same as `needs_ai`). Use `PPD_SCREEN_PASS_SKIP_AI=1` only if you want to skip Bedrock on pass. For hidden copy without segment replay, `PPD_TEXT_EXPANSION_MODE=vision` at capture still helps on skipped pass runs.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `PPD_TEXT_EXPANSION_MODE` | `selectors` | `selectors` \| `vision` \| `both` \| `segment` |
| `PPD_BLOCK_INTERACTION` | off (on when mode=segment) | Extend segment prompt + crop fallback analysis |
| `PPD_SEGMENT_INTERACTION_REPLAY` | off | After segment loop, re-open URLs and run audit on expanded text |
| `PPD_TEXT_EXPANSION_MAX_ACTIVATIONS` | 30 | Click budget |
| `PPD_TEXT_EXPANSION_MAX_NEXT_CLICKS` | 12 | Carousel “next” rounds per control |

## Artifacts

- `pairs/<slug>/interaction-manifest.json` — regions with `blockBbox`, `controls[]`, `iter`, `label`
- `pair-report.json` → `interactionManifest`, per-iteration `interaction` / `interactionManifestEntry`
- `textExpansion.mode` in capture metadata: `vision`, `segment`, `selectors`, etc.

## Tuning

1. Try `PPD_TEXT_EXPANSION_MODE=vision` on a failing pair (e.g. Marvell carousel) without running the full segment loop.
2. For block-specific plans, enable `PPD_TEXT_EXPANSION_MODE=segment` and `PPD_SEGMENT_INTERACTION_REPLAY=1` on `needs_ai` pairs only.
3. Inspect `interaction-manifest.json` and iteration `interaction` fields when clicks miss — tighten segment bboxes (loose boxes mis-place controls).
