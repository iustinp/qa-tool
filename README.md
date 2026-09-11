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
# Edit .env with AWS_BEARER_TOKEN_BEDROCK + AWS_REGION + ANTHROPIC_MODEL (or ANTHROPIC_API_KEY)
```

Verify Bedrock auth:

```bash
node index.js --probe-bedrock
```

## Run

```bash
node index.js --csv pairs.csv
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
# Deterministic, AI-free text + layout audit (no credentials needed):
node index.js --csv pairs.csv --text-only

# …plus the one-hop interaction crawl (tabs/accordions/modals), 5 pairs in parallel:
node index.js --csv pairs.csv --text-only --crawl --threads 5

# Tag a run's folder while keeping the date prefix:
node index.js --csv pairs.csv --text-only --out ./"$(date +%Y%m%d%H%M%S)_baseline"

# Full pipeline including AI block segment/match (needs Bedrock/Anthropic auth):
node index.js --csv pairs.csv --threads 3
```

Open `pairs/<slug>/layout-review.html` from a run to inspect the source↔target overlay (matched/missing/extra boxes, drift connectors).

### Options

| Option | Default | Purpose |
|--------|---------|---------|
| `--csv <file>` | — (required) | Pairs file (comma- or semicolon-separated `source,target`). |
| `--out <dir>` | `<YYYYMMDDHHMMSS>_<csv filename>` | Output folder. |
| `--threads N` | `1` | Pairs processed in parallel. |
| `--max-iterations N` | `40` | Cap on the AI segment/match loop per pair. |
| `--text-only` | off | Capture + text/layout audit only — no image screening, no AI, no credentials. |
| `--screening-only` | off | Capture + local screening only; no AI loop. |
| `--no-screening` | off | Force AI for every pair (skip the local pass/fail screen). |
| `--crawl` | off | One-hop interaction crawl: click non-navigating triggers and compare revealed content (slower). |
| `--layout-audit` / `--no-layout-audit` | on | Deterministic text-geometry audit → missing/extra copy + drift. |
| `--layout-canonical` / `--no-layout-canonical` | on | Compare positioned "pears" (DOM-agnostic). Off falls back to raw DOM geometry. |
| `--layout-ocr` / `--no-layout-ocr` | off | Derive text geometry by OCR of the screenshots (needs the `tesseract` binary). |
| `--cache` / `--no-cache` | off | Reuse vision segment/match results for identical inputs (`PPD_CACHE=1` also enables). |
| `--recipe <file>` | none | Per-site YAML: ignore/mask/normalize rules, capture profiles, interaction hints. |
| `--probe-bedrock` | — | One auth check call; exits 0 if credentials work. |
| `--help`, `-h` | — | Full option + environment reference. |

Run `node index.js --help` for the complete list, including `PPD_*` environment tuning.

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

Debug detail: `<out>/run-debug.log` (not stdout).
