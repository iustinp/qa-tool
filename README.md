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
node index.js --csv pairs.csv --out ./my-run --threads 1
```

CSV columns: `source,target` (header optional).

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
- `pairs/<slug>/` — screenshots, crops, `pair-report.json`, `text-audit.json`

Debug detail: `<out>/run-debug.log` (not stdout).
