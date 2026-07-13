# Roadmap — automated Source → EDS migration QA

This tool is growing from a single source/target page-pair differ into an automated
QA system that verifies migrations from an **arbitrary Source platform** to **Adobe
EDS** (the Target). Scope: verify the page **looks mostly the same** (visual) and that
**all content is present** (content). Functionality is explicitly out of scope for now.

## Locked constraints

- **Scale:** potentially **thousands of pages** per migration. Cache hit-rate and
  avoiding needless vision calls dominate the economics.
- **Target is always EDS** — a known, predictable block structure. Vision segmentation
  is really only needed on the arbitrary Source; the Target can be parsed structurally.
- **Automate as much as possible**, but keep a per-site **recipe** config that stays
  **human-tweakable**. AI "scouts" generate the recipe; every field carries provenance
  (`ai-scout | human`) and human edits are never overwritten.

## Principles

1. **Two axes, decoupled.** Content = DOM/text, almost entirely AI-free. Visual =
   screenshots, AI only on the ambiguous tail. Neither blocks the other.
2. **Exploit the asymmetry.** Vision segmentation on the Source only; parse the Target
   structurally from EDS blocks.
3. **Config is a versioned artifact with provenance.** Nothing is a black box; humans
   override AI guesses.
4. **Output is triage, not a verdict.** pass / fail / needs-review, ranked worst-first.
   Success = shrinking the human review queue, not eliminating it.
5. **Cost is a first-class metric.** Vision-call count and cache hit-rate are logged and
   gate every design decision.

## Architecture

```
Recipe (per-site YAML, provenance-tagged)   <- AI scouts generate, humans tweak
        |
State Capture ---------------------------------------------------------------
  profile dimension:      desktop / mobile / tablet (Playwright device presets)
  interaction dimension:  click-everything BFS (DOM-driven)
  -> per (profile, state): visibleText, screenshot, domSignature
  -> target only: parsed EDS block structure
        |
Comparison ------------------------------------------------------------------
  Content comparator (AI-free): union-per-side + per-profile, w/ normalize rules
  Visual comparator  (AI, funneled): regional pixel diff -> vision only on changed
                     bands; target segmentation from EDS structure, not vision
        |
Caching (cross-cutting): screening funnel . prompt cache . content-hash result cache
        |
Triage & Reporting: per-page/per-axis verdict . ranked review queue . incremental re-runs
```

### Central data model (introduced in Phase 0)

```
PageCapture { url, role, profiles: { [name]: {
    states: [{ id, interactionPath, screenshotPath, domSignature }],
    visibleTextUnion: string[],
    edsBlocks?: [...]        // target only
}}}
```

### Recipe schema (sketch)

```yaml
site: { sourceOrigin, targetOrigin }
profiles: [desktop, mobile]
ignore:   [{ selector: "#onetrust-banner-sdk", reason: cookie }]   # excluded from all comparison
mask:     [{ selector: ".carousel--autoplay" }]                    # visual-only (dynamic regions)
normalize:[{ from: "Sign in", to: "Log in" }, { ignorePattern: "\\d{1,2}:\\d{2}\\s?(am|pm)" }]
interaction: { denylist: [".add-to-cart","button[type=submit]"], hints: [{selector:".faq", action: expand-all}] }
knownDiffs: [{ source, target, accept: true }]
provenance: { "ignore[0]": { by: ai-scout, confidence: 0.9, reviewed: false } }
```

## Phases

Each phase is independently shippable and has a concrete acceptance gate.

### Phase 0 — Foundations / refactor *(enables all others)*
- `profile` abstraction + `PageCapture` data model; profile-parameterize capture and `processPair`.
- `lib/recipe.js` (load + validate + provenance) applied across capture and both comparators.
- `lib/cache-store.js` scaffold (SQLite or keyed-JSON on disk).
- **Gate:** an existing desktop single-profile run reproduces today's output through the
  new model (regression parity), no behavior change.

### Phase 1 — Media profiles (issue #2)
- Run the full pipeline per profile via Playwright device presets (viewport + UA together
  → covers CSS-media *and* UA/server-based differences).
- Visual: strictly per-profile. Content: per-profile **plus** a union rollup separating
  *missing-entirely* (defect) from *present-in-different-viewport* (usually acceptable).
- `--profiles desktop,mobile`.
- **Gate:** a page with mobile-only content is audited correctly under both profiles and
  the rollup labels it right.

### Phase 2 — Caching + EDS structural shortcut (issue #4)
- Prompt caching on the large static segment/match prompts (quick win).
- Content-hash result cache keyed by `hash(image crop + prompt version)` — the big lever
  across template-driven sites (shared header/footer/nav recur across many pages).
- Regional (banded) pixel diff so vision only sees *changed* regions.
- EDS block parser for the Target → skip target-side vision segmentation entirely.
- **Gate:** on a batch sharing chrome, measured vision-call count drops materially vs
  baseline (from `run-debug.log`), with identical results on cache hits.

### Phase 3 — Click-everything crawler (issue #3)
- Bounded BFS: candidate discovery via CDP `getEventListeners` (+ role/aria/pointer
  heuristics), novelty pruning by text/DOM signature, navigation guard (no page escapes),
  network+mutation settle after each click, config denylist for destructive controls.
- Replaces/extends `text-expansion.js`; feeds `visibleTextUnion`. Vision-guided control
  detection demoted to a fallback.
- **Gate:** on a tabs/accordion/carousel page, union text recall ≥ current modes; zero
  navigation escapes; runtime within budget.

### Phase 4 — AI scouts (config auto-generation)
- Scout pass over a sample of source pages proposes the recipe: cookie/consent detection,
  interactive-component inventory, dynamic-region detection (double-capture diff → masks),
  timestamp/personalization detection, profile-relevance (does content differ by viewport?).
- Emits `recipe.yaml` with `provenance.by: ai-scout`; human edits flip provenance to
  `human` and are never overwritten on re-scout.
- **Gate:** scout output on a fresh site needs only minor human edits and its masks remove
  known flaky diffs.

### Phase 5 — Triage & reporting at scale
- Per-page, per-axis verdicts; a ranked review queue (worst first); batch rollups.
- Incremental re-runs: only changed pages, riding the content-hash cache.
- **Gate:** a large run yields a prioritized queue and a re-run is fast due to cache reuse.

## Cross-cutting (every phase)

- **Determinism/flakiness** is the top risk — handled by recipe `mask`/`normalize` +
  dynamic-region detection.
- **Observability:** vision-call count, cache hit-rate, per-phase timings, cost estimate,
  all into `run-debug.log`.
- **Idempotency & budgets:** hard caps on clicks / time / vision per page.
- **Docs:** each phase updates `README.md` / `SCREENING.md`, plus a new `RECIPE.md`.

## Issue map

| Phase | GitHub issue |
|-------|--------------|
| 0 — Foundations | (new) |
| 1 — Media profiles | #2 |
| 2 — Caching + EDS parse | #4 |
| 3 — Click-everything | #3 |
| 4 — AI scouts | (new) |
| 5 — Triage & reporting | (new) |

(Issue #1 — "only run text comparison" — shipped as `--text-only`, the seed of the
AI-free content axis.)
