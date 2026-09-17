# qa-tool

Compare source vs target page pairs: Playwright capture, local screening, full-page text audit, and iterative AI block segment/match.

Self-contained CLI — configuration lives in this repo root (`.env`), not in any parent monorepo.

## Setup

```bash
git clone https://github.com/iustinp/qa-tool.git
cd qa-tool
npm install
npx playwright install chromium
cp .env.example .env
# OPTIONAL: Edit .env with AWS_BEARER_TOKEN_BEDROCK + AWS_REGION + ANTHROPIC_MODEL (or ANTHROPIC_API_KEY). This is not needed by default.
```

Verify Bedrock auth if set above:

```bash
node index.js --probe-bedrock
```
## Web UI

A local web app to run comparisons, manage per-site recipes, and browse results — no CLI needed. It drives the same engine as the CLI.

```bash
# Start it (kills anything already on the port first), then open http://localhost:4321
lsof -ti tcp:4321 | xargs kill; node webui/server.js
```

What it gives you:

- **Start runs from the browser** — paste `source,target` pairs (or **Browse** a CSV), pick a **mode** (Full / Text-only / Screening-only) and **threads**, and go. Live progress; results open in a side panel with source/target screenshot thumbnails and links to the reports.
- **Site recipes** — save a website's specifics (ignore/click selectors, resolutions) as a named, git-shareable recipe and load it before a run. See [Site recipes](#site-recipes).
- **Site filter** — every run is tagged by its source host; a searchable multi-select dropdown filters the history by site. Loading a recipe focuses the list on its site; starting a run always brings its site into view.
- **Run history** — persisted to disk (survives restarts), newest first with "Load more". Each run shows config chips (mode / threads / ignore / click / recipe — click a chip for the exact selectors) and an analyzed / load-errors count. **Load** replays a run's settings into the form to re-run with tweaks; **✕** deletes it (from the list and disk).
- **Resolutions** — analyze at multiple screen widths; the reports come back tabbed per resolution. See [Multi-resolution](#multi-resolution).

Runs are stored under `webui/runs/<id>/` (gitignored); saved recipes under `recipes/` (git-tracked, shareable). Server env knobs: `WEBUI_PORT` (default 4321), `WEBUI_MAX_CONCURRENT` (default 2), `WEBUI_ENGINE=stub` (fake runs for UI work), `--port <n>`.

## Run CLI

```bash
# Deterministic, AI-free text + layout audit (no credentials needed) on 8 threads:
node index.js --csv pairs.csv --threads 8 --text-only 
```

With no `--out`, results land in `./<YYYYMMDDHHMMSS>_<csv filename>/` (date first, so runs sort chronologically and the source file is obvious — e.g. `20260910143512_pairs.csv/`).

### CSV format

One pair per line, `source` then `target`, separated by **either a comma or a semicolon**. A header row (`source,target` / `source;target`) is optional. Fields may be quoted.

```csv
https://example.com/original,https://example.com/migrated
https://example.com/other;https://example.com/other-migrated
```

### Common examples

```bash
# Using --crawl adds the the N-hop interaction crawl (clicks through tabs/accordions/modals/whatever is clickable or hoverable), and saves each state for reprocessing. --threads = 5 pairs in parallel. - !STILL NEEDS WORK:
node index.js --csv pairs.csv --text-only --crawl --threads 5

# Tag a run's folder while keeping the date prefix:
node index.js --csv pairs.csv --text-only --out ./"$(date +%Y%m%d%H%M%S)_baseline"


# Old AI-only way - NOT TO BE USED LIKE THIS because it's slow and unreliable! This was the first version of the qa-tool which tried and failed miserably to use AI to QA migrated pages - You should NOT use this, always make sure you have --text-only:
node index.js --csv pairs.csv

```

Open `pairs/<slug>/layout-review.html` from a run to inspect the source↔target overlay (matched/missing/extra boxes, drift connectors). See [Reports](#reports) for what each output report shows.

## Options

| Option | Default | Purpose |
|--------|---------|---------|
| `--csv <file>` | — (required) | Pairs file (comma- or semicolon-separated `source,target`). |
| `--out <dir>` | `<YYYYMMDDHHMMSS>_<csv filename>` | Specify Output folder. |
| `--threads N` | `1` | Pairs processed in parallel. Be careful not to get blocked - 5-8 threads is usually ok, from 10+ even our EDS will block you |
| `--max-iterations N` | `40` | Cap on the AI segment/match loop per pair |
| `--text-only` | off | Capture + text/layout audit only — no image screening, no AI, no credentials. |
| `--screening-only` | off | Capture + local screening only; no AI loop - This is also an older feature that tried to use local pre-AI checks and stops before using AI |
| `--no-screening` | off | Force AI for every pair (skip the local pass/fail screen). |
| `--crawl` | off | One-hop interaction crawl: click non-navigating triggers and compare revealed content (slower). |
| `--layout-audit` / `--no-layout-audit` | on | Deterministic text-geometry audit → missing/extra copy + drift. |
| `--layout-canonical` / `--no-layout-canonical` | on | Compare positioned "pears" (DOM-agnostic). Off falls back to raw DOM geometry. |
| `--layout-ocr` / `--no-layout-ocr` | off | Derive text geometry by OCR of the screenshots (needs the `tesseract` binary). |
| `--cache` / `--no-cache` | off | Reuse vision segment/match results for identical inputs (`PPD_CACHE=1` also enables). |
| `--recipe <file>` | none | Per-site YAML: ignore/click selectors, resolutions, mask/normalize, profiles. See [Site recipes](#site-recipes). |
| `--resolutions <list>` | none | Analyze at several widths, e.g. `1440,768m,375m` (trailing `m` = mobile UA). Overrides the recipe's. See [Multi-resolution](#multi-resolution). |
| `--probe-bedrock` | — | One auth check call; exits 0 if credentials work. |
| `--help`, `-h` | — | Full option + environment reference. |

Run `node index.js --help` for the complete list, including `PPD_*` environment tuning.

## Site recipes

A **recipe** is a per-site YAML file (`--recipe <file>`, or picked in the Web UI) that captures a website's specifics so runs of its pages reflect real correctness. Recipes are plain YAML, usable by both the CLI and the UI, and meant to be committed to `recipes/` and shared with the team. See [`recipe.example.yaml`](./recipe.example.yaml) for the full annotated format. The main fields:

- **`ignoreSource` / `ignoreTarget`** — CSS selectors for **known-issue regions** to exclude from comparison, per side (source and target DOMs differ). The matched element stays in place but is hatched over (a red/white overlay) and left out of the pears/text audit, so a known issue can't skew the result — and you can see exactly what was ignored.
- **`clickSource` / `clickTarget`** — selectors to **click before capture if present** (e.g. a cookie **Accept**/**Deny** button, an "enter site" gate). Per side; runs deterministically even in text-only mode.
- **`resolutions`** — the widths to analyze at (see below).
- Also supported: shared `ignore` (both sides), `mask` (visual-diff-only), `normalize` (text rewrites), and capture `profiles`.

In the Web UI these are the **ignore / click / resolutions** boxes; **Save…** stores them as a named recipe (tagged with the site so loading it filters the runs list).

## Multi-resolution

Sites serve different content and layouts at different breakpoints — and often by user-agent too. A recipe's `resolutions` list runs the whole pipeline **once per width**:

```yaml
resolutions:
  - { width: 1440, ua: desktop }   # desktop UA, DPR 1
  - { width: 768,  ua: mobile }    # phone UA + touch + DPR 3 → the site's mobile content
  - { width: 375,  ua: mobile }
```

Each resolution gets its own screenshots, pears, and audit, and both `report.html` and `CUSTOMER-Report.html` become **tabbed by resolution** — each tab labeled by width with a coloured badge of that resolution's worst score, so a bad breakpoint stands out even if the first tab looks green. Per-pair reviews are `layout-review-<width>.html`. With no `resolutions`, behavior is unchanged (single desktop capture). In the Web UI, add widths in the **Resolutions (widths)** box.

## Reports

> ⚠️ **This tool is being developed fast.** The reports change often, and the UI may gain or lose controls before this description catches up. If something on screen doesn't match what's written here, trust the screen — and the tooltips (hover any toolbar control in the layout review).

A run produces three HTML reports. Open them straight from the run folder (they are self-contained — they also work over `file://`). When a run uses multiple [resolutions](#multi-resolution), `report.html` and `CUSTOMER-Report.html` are **tabbed by resolution** (each tab badged with that resolution's worst score).

### `report.html` — the internal scoreboard

The engineer-facing overview: one sortable row per pair.

- **Columns:** *General Health %* (overall, higher = better), the *Content Completeness* family (Content %, Matched / Missing / Extra text counts), and the *Drift* family (*Drifting texts %* plus Small / Medium / Large drift counts). Health & Content are higher = better; Drift is lower = better — cells are colour-coded accordingly.
- **Navigate:** click any column header to sort (click again to flip direction); the default is worst General Health first. Each row's **Source · Target** links open the two live pages (⌘/Ctrl-click or middle-click to open in a background tab); the **review ↗** link opens that pair's `layout-review.html`. Rows that failed to capture or score show "—" and sort last.

### `CUSTOMER-Report.html` — the customer-facing summary

A trimmed version of `report.html`, safe to share (all-caps name so it is never confused with the internal one). No health/drift internals, no review links.

- **Columns:** *Original page* · *Edge Delivery page* (source/target links), the page path, *Content Completeness %*, and *Mismatches* (missing + extra count).
- **Navigate:** click a **Mismatches** count to open a modal listing the actual text elements in two columns — *Only on Original page* (missing on target) and *Only on Edge Delivery page* (extra on target). Each cell has a **Copy** button, and double-click selects the cell's text. Each cell also has a comments textbox next to it, so that a user can write comments about that cell. After writing any comments, the user NEEDS to click the '💾 Save copy with comments' button to download a copy of the report with the comments inside (security limitations don't allow saving directly to the same file).

### `pairs/<slug>/layout-review.html` — the per-pair overlay

The deep-dive for a single pair: source and target text laid over the page so you can see exactly what moved, what's missing, and what's extra. One side fills the stage at a time.

- **Opens on:** the **Target** (Edge Delivery) page, **Screenshot** backdrop, with **Connectors** on.
- **Toolbar (hover any control for its tooltip):**
  - **source / TARGET** — which page fills the stage. Click, or press **Spacebar**, to toggle.
  - **Pear / Screenshot** — the backdrop: the reconstructed text canvas ("pear") vs the actual captured screenshot.
  - **Source boxes / Target boxes** — draw each side's text-run boxes (green source / red target).
  - **Matched** — colour matched pairs blue instead of the per-side colours.
  - **Indices** — number each box in reading order.
  - **Connectors** — line each matched source run to its target counterpart, coloured by positional drift (green ≤20px, yellow ≤40px, red >40px).
  - **Clickable** — outline clickable/hoverable regions that can reveal any new text, and the interactive state-entry boxes you can click to descend into crawl-revealed content.
  - **Revealed text / Hidden content** — highlight newly-revealed text inside a crawled state, and off-screen slider/carousel slides at their natural flow position.
  - **Diffs** — open a side panel listing every missing / extra / matched run.
- **Align two boxes:** click any box to rigidly shift the other side so that pair lines up (useful for reading residual drift); **Reset align** clears it.

## Configuration

| File | Purpose |
|------|---------|
| `.env` | AI credentials and `PPD_*` tuning (gitignored) |
| `.env.example` | Template — copy to `.env` |
| `.env.local` | Optional overrides (gitignored, loaded after `.env`) |

All env loading is from **this directory only** (`lib/load-env.js`).

## Docs

- [SCREENING.md](./SCREENING.md) — local pass/fail/needs_ai thresholds, text audit, match strictness
- [INTERACTION.md](./INTERACTION.md) — vision-guided carousel/tab expansion

## Artifacts (per run)

- `summary.json`, `summary.jsonl`, `screening-summary.csv`, `missing.csv`, `text-missing.csv`
- `report.html` — sortable per-pair scores (health / content / drifting texts)
- `pairs/<slug>/` — screenshots, crops, `pair-report.json`, `text-audit.json`
  - `layout-review.html` — interactive source↔target overlay (matched/missing/extra + drift connectors)
  - `layout-audit.json`, `source-clm.json`, `target-clm.json`, and `crawl.json` (with `--crawl`)
  - Multi-resolution runs also write per-width variants: `screenshots/source-<width>-full.png`, `layout-audit-<width>.json`, `<width>-source-clm.json`, `layout-review-<width>.html`.

Debug detail: `<out>/run-debug.log` (not stdout).
